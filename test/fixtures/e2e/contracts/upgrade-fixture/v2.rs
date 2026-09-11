#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env};

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn init(env: Env, admin: Address) {
        let key = symbol_short!("ADMIN");
        if env.storage().instance().has(&key) {
            panic!("already initialized");
        }
        env.storage().instance().set(&key, &admin);
    }

    pub fn version() -> u32 {
        2
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("ADMIN"))
            .expect("not initialized");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}
