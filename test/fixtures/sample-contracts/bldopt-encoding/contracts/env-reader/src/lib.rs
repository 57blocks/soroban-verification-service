#![no_std]

use soroban_sdk::{contract, contractimpl, Env, Symbol};

const BUILD_VALUE: &str = env!("B");

#[contract]
pub struct EnvReader;

#[contractimpl]
impl EnvReader {
    pub fn value(env: Env) -> Symbol {
        Symbol::new(&env, BUILD_VALUE)
    }
}
