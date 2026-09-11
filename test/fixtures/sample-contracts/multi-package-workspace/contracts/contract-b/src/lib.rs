#![no_std]

use soroban_sdk::{contract, contractimpl, Env, Symbol};

#[contract]
pub struct ContractB;

#[contractimpl]
impl ContractB {
    pub fn selected(env: Env) -> Symbol {
        Symbol::new(&env, shared_flags::selected())
    }
}
