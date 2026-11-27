# Runbook: Arweave archiving and its funder

What to do when an `arweave-funder-*` or `orchestrator-arweave-*` alarm fires. The funder's state is one
S3 object, `SCVS_FUNDER_STATE_BUCKET`/`SCVS_FUNDER_STATE_KEY`; every step below that edits it writes it
back whole, while the funder is stopped (`desired_count` 0), so no round holds its lease.

## The funder halted (`halted`)

The funder signs nothing until `halted` is removed from its state object. The reason in that field says
which of three things happened.

1. **"unexpected outflow" or "nonce N was consumed by a transaction this funder did not record".** The
   funding key signed something this code did not. List the funding address's transactions on a block
   explorer and match each nonce against `txs` in the state. Any nonce the state does not hold is a
   transaction someone else signed. Treat it as a compromise until shown otherwise: deny `kms:Sign` in
   the funding key's policy, move what is left at the address, and follow the incident process. Only
   when every unrecorded nonce is explained, set `nextNonce` to the chain's nonce and remove `halted`.
2. **"Turbo reports deposit address …".** Turbo's payment service named a different deposit address
   from `SCVS_FUNDER_DEPOSIT_ADDRESS`. Confirm the new address with ArDrive through a channel other than
   their API before changing the configuration; until then nothing is sent.
3. **"… was credited by Turbo, then reorganised out of the chain"** (also raises `reorged`). Look the
   hash up again: if the network included it in a later block, mark that transaction `credited` with its
   new `blockNumber`; if it is gone for good, its nonce is free again and `nextNonce` must be set back to
   the chain's nonce. Then remove `halted`.

## The funder will not start: "Irys-era state … still signed/broadcast"

The state object predates Turbo and holds a transfer to Irys's deposit address that may still land. Look the
hash up: once it is mined or provably gone, set its status to `mined` (it is then settled as refused, since
Turbo cannot credit an Irys deposit) or `dropped`, and start the funder again.

## A top-up is stuck (`tx_stuck`)

A nonce was re-priced `SCVS_FUNDER_MAX_REPLACEMENTS` times and is still unmined; the funder only
watches it. If fees have fallen it will land on its own. If not, raise `SCVS_FUNDER_MAX_FEE_PER_GAS_WEI`
or `SCVS_FUNDER_MAX_REPLACEMENTS` and redeploy; the next round re-prices it once more.

## Turbo refused a deposit (`credit_rejected`)

The transfer mined, the funder offered it to Turbo every round until its block was safe, and Turbo still
refused it. The ETH has left the funding address. Take the hash to ArDrive. Nothing needs undoing in the
funder: the transaction stays `rejected` and still counts against the day's top-up cap.

## No credits to share (`share_unfunded`)

The upload key's share is due, but the funding key's spendable credits cannot cover another one. It
clears once a top-up is credited; if it does not, follow the insufficient-balance steps below.

## Uploads stop with insufficient balance (`orchestrator-arweave-insufficient-balance`)

Turbo answered 402: the funding key's credits, or the share it gave the upload key, ran short. Check, in
order: the funder is running and not halted; `arweave_funder_credits_balance` and
`arweave_funder_shared_remaining_credits`; `approval_cap_reached` (uploads spent the share faster than
the window allows); the funding address's ETH (`chain_balance_low`). Archives retry on their own once
credits are back.

## An upload missed its deadline (`orchestrator-arweave-upload-overdue`)

Turbo accepted an item but it was not on Arweave by the height Turbo promised, so the orchestrator
uploaded it again. One is Turbo's lapse. Several in a row mean Turbo is not bundling: check ArDrive's
status, and expect archives to stay pending until it recovers.
