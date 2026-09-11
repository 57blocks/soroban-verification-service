import { IsIn, IsOptional, IsString } from "class-validator";
import { networks, type Network } from "./enums.js";
import { LowercaseHex } from "./validators/lowercase-hex.js";

// What is being verified.
export class VerificationTarget {
  @IsIn(networks)
  network!: Network;

  @IsOptional()
  @IsString()
  contract_id?: string;

  /** Lowercased on parse, and deliberately NOT `@Matches`ed here. */
  @IsOptional()
  @IsString()
  @LowercaseHex()
  wasm_hash?: string;
}
