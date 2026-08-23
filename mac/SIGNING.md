# Signing and notarising

Without this, a downloaded Bridge needs a right-click → **Open** on first launch. With it, it is an
ordinary double-click. Both build scripts detect the setup automatically and fall back to an ad-hoc
signature when it is missing, so nothing breaks if you skip it.

Two one-off steps, both needing a browser login, so they are yours to do:

### 1. A Developer ID Application certificate

An *Apple Development* certificate is not enough — that one is for running on your own devices.
Distribution outside the App Store needs **Developer ID Application**.

1. https://developer.apple.com/account/resources/certificates/list → **+**
2. Choose **Developer ID Application**, follow the CSR steps, download the `.cer`
3. Double-click it so it lands in your login keychain

Check it took:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

### 2. A notary credential

Create an app-specific password at https://appleid.apple.com → Sign-In and Security →
App-Specific Passwords, then store it once:

```bash
xcrun notarytool store-credentials "bridge-notary" \
  --apple-id "you@example.com" \
  --team-id "G5WKXJZ596" \
  --password "abcd-efgh-ijkl-mnop"
```

Your team id is **G5WKXJZ596** (read from the signature of a locally signed build).

### Then

```bash
./mac/dmg.sh
```

It signs the app with the hardened runtime and a secure timestamp, signs the image, submits it to
Apple, waits, staples the ticket, and prints the Gatekeeper verdict. A first submission usually
takes two to five minutes.

Overrides, if you need them: `BRIDGE_SIGN_ID="Developer ID Application: …"` and
`BRIDGE_NOTARY_PROFILE=some-other-profile`.
