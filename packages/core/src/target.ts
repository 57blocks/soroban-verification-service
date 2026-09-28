import { IsIn, IsOptional, IsString } from "class-validator";
import { networks, type Network } from "./enums.js";
import { LowercaseHex } from "./validators/lowercase-hex.js";

export class VerificationTarget {
  @IsIn(networks)
  network!: Network;

  @IsOptional()
  @IsString()
  contract_id?: string;

  @IsOptional()
  @IsString()
  @LowercaseHex()
  wasm_hash?: string;
}
