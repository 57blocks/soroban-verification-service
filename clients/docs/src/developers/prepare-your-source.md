# Prepare your source

The verifier rebuilds an archive of your source, so the archive decides the result: the exact bytes the
contract was built from verify, and anything else does not. This page covers what the archive may
contain, how to hand it over, and what happens to it afterwards.

## The archive

| Rule | Default limit |
| --- | --- |
| A gzip tarball (`.tar.gz`, `.tgz`) or a zip file, recognised by its bytes, not its name. An upload must be one of these; a URL may also serve an uncompressed tar | — |
| Size, as sent | 50 MiB |
| Number of entries | 20,000 |
| Size once unpacked | 512 MiB |
| Regular files and directories only: no symbolic links, devices or other special files | — |
| No absolute paths, and no paths that climb out with `..` | — |

A verifier can change the limits. A source archive that breaks a rule fails with a `source_archive_*`
code; see [Failure codes](../api/errors.md#failure-codes).

### Layout

Put the files at the top of the archive, or under one top-level directory, which the verifier strips.
Paths in your build options, such as `--manifest-path=contracts/token/Cargo.toml`, are relative to
that root. With no `--manifest-path`, the build uses the `Cargo.toml` at the root.

Include `Cargo.lock`; the verifier resolves dependencies from it. Leave out `target/` and any built
Wasm: a build that reports a Wasm already in the archive is refused, so a stale file cannot pass for the
rebuild.

### An archive inside an archive

An archive holding exactly one file, which is itself an archive, is unwrapped, up to four levels, so a
tarball that something zipped for transport still builds; the inner archive is what is published if you
make the source public. The hash that counts is still the outer file's: the `source_sha256` you submit,
and the one a contract records on chain, are both checked against the file you hand over. If the
contract records a hash, submit the archive itself, not a wrapper around it.

## The hash

`source_sha256` is the SHA-256 of the archive's bytes:

```sh
sha256sum my-contract.tar.gz
```

The bytes have to stay the same. Make the archive once and keep that file. Do not rely on an archive a
host generates on request, such as a Git forge's "download as tarball" link: some hosts regenerate those
archives, and the bytes, and so the hash, can change from one download to the next.

If the contract records a `source_sha256`, submit the archive with that hash. The verifier refuses any
other archive at submission, with `source_archive_not_chain_recorded`. The console checks this as soon as
you pick a file.

## Handing it over

| | At a URL | As an upload |
| --- | --- | --- |
| You send | The URL and the archive's SHA-256 | The archive itself; the response gives an `upload_id` and the SHA-256 the verifier computed |
| When the verifier reads it | When the job runs | At upload |
| Limits | HTTPS only, no private or local addresses, at most 5 redirects, 2 minutes to download | Use it within 30 minutes |
| Published with the result | The URL, always | Nothing but the hash, unless you declare the source public |

Whichever way it arrives, the verifier checks the bytes against the hash before it builds anything.
A download that hashes differently fails the job; an upload whose `upload_id` and `source_sha256` do not
agree is refused at submission with `source_hash_mismatch`.

[Submit a contract with curl](../quick-start/submit-with-curl.md#_3-point-at-the-source) shows both ways.

## Public or private

The archive's route to the verifier, and whether it is published, are separate choices. Publication is
the `is_public` flag, or **Publish this source publicly** in the console, and it is off by default:

- **Private.** The verifier uses the archive for the rebuild and does not keep it. An upload is deleted
  once no job still needs it. The result publishes the archive's hash, and its URL if you gave one.
  Anyone holding the same archive can still check it against the hash.
- **Public.** The verifier also stores the archive in its result root, at `sources/<sha256>` with the
  archive's own extension, and lists it in the status object's `verified_source_code_uris`. Anyone can then download the
  exact source and repeat the rebuild without asking you for it.

A private source is a complete verification. A public one is a stronger claim, because nobody has to
take your word that the archive exists.

A submission made without a manifest, which the verifier completes from the contract's own metadata, is
private.
