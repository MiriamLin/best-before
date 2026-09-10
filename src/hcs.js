import { Client, PrivateKey, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[hcs] ${name} must be set in .env`);
  }
  return value;
}

const accountId = requireEnvironmentVariable("HEDERA_ACCOUNT_ID");
const privateKey = requireEnvironmentVariable("HEDERA_PRIVATE_KEY");
const topicId = requireEnvironmentVariable("HCS_TOPIC_ID");

const client = Client.forTestnet();
client.setOperator(accountId, PrivateKey.fromStringECDSA(privateKey));

const pendingReceiptWrites = new Set();

export function submitReceipt(receipt) {
  const writePromise = new TopicMessageSubmitTransaction({
    topicId,
    message: JSON.stringify(receipt),
  })
    .execute(client)
    .then((response) => response.getReceipt(client));

  pendingReceiptWrites.add(writePromise);
  writePromise.then(
    () => pendingReceiptWrites.delete(writePromise),
    () => pendingReceiptWrites.delete(writePromise),
  );

  return writePromise;
}

export async function waitForPendingReceiptWrites() {
  await Promise.allSettled(pendingReceiptWrites);
}
