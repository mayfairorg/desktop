# Ghost vault (developer notes)

Code: `src/main/ghost/vault/` (vault.js, aead.js, kdf.js, argon2id.js, blake2b.js, bip39.js, keystore.js, securefs.js, service.js). Page: `src/ui/ghost-vault/`. Tests: `test/ghost-vault*.test.js`.

- Format `MFV1`: header (magic, version 1, algorithm 1 = AES-256-GCM, key id) + 12-byte IV + ciphertext + 16-byte tag; header and a context string (vault id, section, record id) are AAD.
- Keys: device key (Electron safeStorage; file-permission fallback with a plain warning) and, only with Backup on, an Argon2id passphrase key (64 MiB, 3 passes) and a 12-word phrase key each wrap the master key; the master key seals a key table; data keys are split per section with HKDF.
- Download file `MFVB1`: wrapped keys + sealed records + HMAC over the whole body. Import verifies secret, HMAC, key table and every record before replacing anything.
- Sync name `ghost/vault-backup.mfvb`, only while Backup is on. `GhostService` takes `files: { put(name, Buffer), remove(name) }`; pass the Mayfair Files adapter there (none exists in this repo yet).
- KDF order: `argon2` (native), `hash-wasm`, bundled pure JS in a worker thread. Install either of the first two to make unlocking fast; none is bundled.
- Phrase list: `wordlist-en.txt` is Mayfair's own 2048-word list, not the standard BIP-39 English list; the list id is stored in the wrapped key.

## Bridge (add to browser-bridge-contract.md as v3.2)
`browser.ghost.vault.*`: status, unlock({passphrase}|{phrase}), lock, backup.begin({passphrase}), backup.confirm({answers}), backup.cancel, backup.disable, backup.newPhrase, changePassphrase, resetPassphrase, requirePassphrase(bool), rotateKeys({passphrase}?), syncNow, wipe({confirm:'WIPE'}), exportFile, importFile({passphrase}|{phrase}, replace?). Files are chosen in native dialogs; no key or path crosses the bridge.
