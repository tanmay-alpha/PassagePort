# Cryptographic Key and Credential Rotation Policy

## Purpose and Scope

This policy sets out how often cryptographic keys and machine credentials must be replaced, which algorithms may be used, and what must happen when a secret is believed to be exposed. It applies to every system operated by the engineering organization, including test environments that hold copies of customer data. It does not cover passwords chosen by employees for their own accounts, which are governed by the workforce identity standard. The policy is identified in the control catalog as KRP-07 and is reviewed once a year by the security lead.

Rotation limits the damage of a leak that nobody has noticed. A key that is replaced on a schedule gives an attacker a bounded window, and a team that rotates routinely is able to rotate quickly in an emergency. For that reason, rotation must be automated wherever the platform allows it; manual rotation is tolerated only for the classes marked as such below.

## Key Classes and Rotation Intervals

Every secret must be registered in the secrets inventory with an owner, a class, and the date of its last rotation. The maximum lifetime depends on the class.

| Key class | Maximum lifetime | Rotation method |
| --- | --- | --- |
| TLS certificates for public endpoints | 90 days | Automated |
| TLS certificates for internal services | 30 days | Automated |
| Service-to-service API credentials | 180 days | Automated |
| Database account passwords | 60 days | Automated |
| Data encryption keys | 365 days | Automated |
| Key encryption keys held in the hardware module | 3 years | Manual ceremony |
| Code and artifact signing keys | 2 years | Manual ceremony |
| SSH host keys | Life of the host | Replaced on rebuild |

A new secret must be issued at least 7 days before the old one expires, and both must be accepted during that overlap so that deployments can pick up the new value without downtime. Data encryption keys are rotated by wrapping new data with the new key; existing data is re-encrypted lazily and must be fully migrated within 120 days of the rotation.

Credentials that belong to a person who leaves the organization or changes teams must be revoked within one business day, regardless of the schedule above.

## Approved Algorithms and Key Sizes

Only the following algorithms may be used for new keys.

- Symmetric encryption: AES-256-GCM. A single key must not encrypt more than 2 to the power of 32 messages.
- Asymmetric signatures: Ed25519 is preferred; ECDSA with curve P-384 is permitted where a partner requires it.
- RSA: permitted only for compatibility, with a modulus of at least 3072 bits.
- Hashing: SHA-256 or stronger. SHA-1 and MD5 are forbidden for any security purpose.
- Password-derived keys: Argon2id with a memory cost of at least 64 MB.

Systems that still depend on RSA keys of 2048 bits must be listed in the secrets inventory with a migration date no later than the end of the next calendar year. Keys must be generated inside the hardware module or by the approved secrets manager, never on a laptop and never by a script that prints the key to a terminal.

## Storage and Handling

Secrets must be delivered to workloads at run time by the secrets manager. They must not appear in source repositories, container images, build logs, chat messages, or tickets. The repository scanner blocks commits that contain strings matching known credential formats, and a blocked commit is treated as an exposure even if it never reached the shared branch.

The two manual ceremonies require at least three of the five designated key custodians to be present. Each ceremony follows a written script, is recorded on video, and produces a signed record that is filed with the audit team.

## Emergency Revocation

A secret is considered compromised when it has been seen by an unauthorized party, or when that cannot be ruled out. Suspicion is enough; proof is not required. The following steps apply.

1. The person who discovers the exposure reports it in the security incident channel immediately and opens a ticket with severity SEV-2 or higher.
2. The owning team revokes the affected secret and issues a replacement within 4 hours of the report. For TLS certificates, revocation includes publishing the serial number to the revocation list.
3. The security on-call engineer reviews access logs for the period in which the secret was exposed and decides whether customer notification is needed.
4. Any secret that was protected by the compromised one, such as data keys wrapped by a leaked key encryption key, is rotated within 72 hours.
5. A written review is completed within 10 business days and linked from the inventory entry.

Teams must be able to prove that they can meet the 4-hour limit. Each team that owns a secret of any automated class performs an unannounced revocation exercise twice a year, and the result is recorded.

## Audit Requirements

Every creation, read, rotation, and revocation of a secret must produce an audit event containing the identity of the caller, the identifier of the secret, and a timestamp. The value of the secret must never be logged. Audit events are retained for 400 days in write-once storage that the owning teams cannot modify.

The security team produces a compliance report on the first working day of each quarter. The report lists every secret whose age exceeds its maximum lifetime, every secret without a registered owner, and every exception that is due to expire. An overdue secret must be rotated or covered by an approved exception within 14 days of appearing in the report; after that, the matter is escalated to the director of the owning department.

## Exceptions Process

Some systems cannot meet an interval, for example an embedded device that can only be updated during a maintenance visit. In such cases the owner submits form SEC-EX-12 describing the secret, the reason, the compensating controls, and the date by which the system will comply.

An exception is granted by the security lead for at most 60 days and may be renewed twice. A third renewal requires the approval of the chief information security officer. Exceptions are never granted for secrets that are known or suspected to be compromised, and they do not relax the algorithm requirements for newly created keys.
