# Security policy

## Supported versions

Security fixes are made against the latest released version. Older pilot
builds and development snapshots may not receive separate patches.

## Reporting a vulnerability

Do not disclose authentication bypasses, token or PIN weaknesses, inventory
integrity issues, backup-encryption failures, or exposed credentials in a
public issue.

Use GitHub’s private vulnerability reporting feature in the repository’s
**Security** tab. Include:

- the affected version or commit;
- reproduction steps and expected impact;
- whether production data or credentials may have been exposed;
- any suggested remediation, if available.

If private vulnerability reporting is temporarily unavailable, contact the
maintainer through the private contact method listed on the repository owner’s
GitHub profile. Do not send production secrets unless an encrypted channel has
been agreed upon.

## Deployment secrets

Repository examples must contain placeholders only. Real `SECRET_KEY` values,
PINs, Android signing material, EasyTier credentials, Cloudflare tokens,
recovery passphrases, production SQLite files, and encrypted-backup passwords
must remain in local or CI secret storage.
