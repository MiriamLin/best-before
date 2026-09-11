import {
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hashgraph/sdk";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const MAX_TRANSACTION_MEMO_BYTES = 100;

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[refund] ${name} must be set in .env`);
  }
  return value;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[refund] ${label} must be a positive safe integer, got ${JSON.stringify(value)}`,
    );
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[refund] ${label} must be a non-empty string`);
  }
}

function requireTransactionMemoWithinLimit(memo) {
  const byteLength = Buffer.byteLength(memo, "utf8");

  if (byteLength > MAX_TRANSACTION_MEMO_BYTES) {
    throw new Error(
      `[refund] transaction memo exceeds ${MAX_TRANSACTION_MEMO_BYTES} bytes: ${byteLength}`,
    );
  }
}

const serviceAccountId = requireEnvironmentVariable("HEDERA_ACCOUNT_ID");
const servicePrivateKey = requireEnvironmentVariable("HEDERA_PRIVATE_KEY");

const client = Client.forTestnet();
client.setOperator(
  serviceAccountId,
  PrivateKey.fromStringECDSA(servicePrivateKey),
);

export async function refundBuyer({
  buyerAccountId,
  tierName,
  tier,
  freshness,
}) {
  requireNonEmptyString(buyerAccountId, "buyerAccountId");

  const refundTinybar = tier.price_tinybar;
  requirePositiveSafeInteger(refundTinybar, "tier.price_tinybar");

  const memo = (
    `BestBefore refund: paid ${tierName}, `
    + `delivered age=${freshness.age_seconds}s, `
    + `sla=${tier.max_age_seconds}s`
  );
  requireTransactionMemoWithinLimit(memo);

  const response = await new TransferTransaction()
    .addHbarTransfer(serviceAccountId, Hbar.fromTinybars(-refundTinybar))
    .addHbarTransfer(buyerAccountId, Hbar.fromTinybars(refundTinybar))
    .setTransactionMemo(memo)
    .execute(client);

  await response.getReceipt(client);

  return {
    refund_tinybar: refundTinybar,
    refund_tx_id: response.transactionId.toString(),
  };
}
