import { x402Client } from "@x402/core/client";
import { PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const HEDERA_TESTNET = "hedera:testnet";

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[payment-client] ${name} must be set in .env`);
  }
  return value;
}

export function createPaidFetch() {
  const buyerAccountId = requireEnvironmentVariable("BUYER_ACCOUNT_ID");
  const buyerPrivateKey = requireEnvironmentVariable("BUYER_PRIVATE_KEY");

  const signer = createClientHederaSigner(
    buyerAccountId,
    PrivateKey.fromStringECDSA(buyerPrivateKey),
    { network: HEDERA_TESTNET },
  );

  const client = x402Client.fromConfig({
    schemes: [
      {
        network: HEDERA_TESTNET,
        client: new ExactHederaScheme(signer),
      },
    ],
    spendControls: false,
  });

  return wrapFetchWithPayment(fetch, client);
}
