// Settings copy for what protects saved passwords, and the Linux fixed-key warning.
import assert from "node:assert/strict";
import { test } from "node:test";
const { cardStoreName, passwordStorageDescription, secretStorageWarning } = await import("./secretStorage.ts");

test("each desktop names its own key store", () => {
  assert.equal(passwordStorageDescription("macos"), "Saved on this Mac, separately for each space, and encrypted with a key in your Keychain.");
  assert.match(passwordStorageDescription("windows"), /this PC.*Windows protects for your account/);
  assert.match(passwordStorageDescription("linux"), /this computer.*desktop keyring/);
  assert.equal(cardStoreName("macos"), "your macOS Keychain");
  assert.equal(cardStoreName("windows"), "Windows Credential Manager");
  assert.equal(cardStoreName("linux"), "your desktop keyring");
});

test("only the fixed key and a missing key warn", () => {
  assert.equal(secretStorageWarning(null), null);
  assert.equal(secretStorageWarning("keyring"), null);
  assert.match(secretStorageWarning("basic").description, /fixed key/);
  assert.match(secretStorageWarning("basic").description, /--password-store=basic/);
  assert.match(secretStorageWarning("unavailable").title, /can't be encrypted/);
});
