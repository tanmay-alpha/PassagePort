# Transaction Isolation in CorvidDB

Isolation is the property that lets concurrent transactions behave, to a chosen degree, as if they ran one after another. CorvidDB offers three isolation levels and implements all of them with multiversion concurrency control. This document explains what each level promises, which anomalies it allows, and how applications should react when the database refuses to commit their work.

## Snapshots and MVCC

CorvidDB never overwrites a row in place. An update writes a new version stamped with the identifier of the writing transaction, and the old version stays behind until no one can need it. A reader works from a snapshot: a record of which transactions had committed at a particular instant. Versions written by transactions outside the snapshot are simply invisible to it.

The practical result is that readers do not block writers and writers do not block readers. Only two writers aiming at the same row have to wait for each other. Old versions are removed later by a background sweeper, and a transaction that stays open for hours prevents the sweeper from removing anything newer than its snapshot. A snapshot older than snapshot_retention_s, 1800 by default, is cancelled with error CDB-2207 to protect the rest of the system.

## The isolation levels

| Level | Snapshot taken | Possible anomalies |
| --- | --- | --- |
| READ COMMITTED | At the start of each statement | Non-repeatable read, phantom, write skew |
| REPEATABLE READ | At the first statement of the transaction | Write skew |
| SERIALIZABLE | At the first statement, plus dependency tracking | None |

The level for new sessions comes from default_txn_isolation, which ships as READ COMMITTED. A transaction can choose another level with SET TRANSACTION as its first statement. There is no READ UNCOMMITTED level; requesting it silently gives READ COMMITTED.

## Anomalies

A dirty read is seeing data that another transaction has written but not yet committed. If that transaction rolls back, the reader has acted on something that never existed. Because every snapshot contains only committed work, CorvidDB cannot produce a dirty read at any level.

A non-repeatable read occurs when a transaction reads the same row twice and gets different values, because another transaction committed a change in between. A phantom is the same problem for sets: a query with the same condition returns additional or fewer rows the second time. Both are possible under READ COMMITTED, where each statement sees a fresh snapshot, and both disappear at REPEATABLE READ.

Write skew is subtler. Two transactions each read an overlapping set of rows, each makes a decision based on what it read, and each writes to a different row. Neither overwrites the other, so no write conflict is detected, yet the combined result breaks a rule that each transaction checked on its own. The standard example is a hospital roster that requires at least one doctor on call: two doctors each see that the other is on call, both remove themselves at the same moment, and the shift ends up empty. Only SERIALIZABLE prevents this.

## Serialization failures

At REPEATABLE READ, if a transaction tries to update a row that was changed by another transaction after its snapshot was taken, it cannot proceed without losing that update. At SERIALIZABLE the engine also tracks read-write dependencies between concurrent transactions and aborts one of them when the dependencies form a dangerous cycle. In both cases the statement or the commit fails with SQLSTATE 40001, serialization_failure.

This error does not indicate a bug. It is the mechanism by which the stronger levels keep their promise, and the correct response is always to run the whole transaction again from the beginning. Retrying only the failed statement is wrong, because the decisions made earlier in the transaction were based on a snapshot that is now known to be stale.

## Retry strategy

Wrap each transaction in a function that can be called repeatedly, and keep side effects outside the database, such as sending mail or calling a payment provider, out of that function. Our client helper run_in_txn applies the following policy:

- Retry on serialization failures and on deadlock errors, never on constraint violations.
- Make at most 5 attempts in total.
- Sleep before each retry, starting at 20 milliseconds and doubling up to a ceiling of 640 milliseconds.
- Add random jitter of up to half the delay so that colliding transactions do not collide again in step.

If the retry rate for a workload climbs above a few percent, shorten the transactions or reduce the set of rows they read rather than adding attempts. Read-only transactions can be declared with the READ ONLY DEFERRABLE option, which waits for a safe snapshot and then can never fail with a serialization error.

## Deadlocks

A deadlock arises when two transactions each hold a lock the other needs: one updates row A then row B while the other updates B then A. Neither can move. CorvidDB does not check for cycles on every lock wait, since that would be expensive. Instead a waiter that has been blocked for deadlock_probe_ms, default 750, triggers a search of the wait graph. If a cycle is found, the transaction that has done the least work is aborted with SQLSTATE 40P01 and the others continue.

The durable cure is consistent ordering. If every code path locks rows in the same order, for instance by ascending primary key, a cycle cannot form. Sorting the identifiers before a batch update removes most deadlocks we see in practice.

## Lock timeouts

A transaction waiting for a row lock waits indefinitely by default, which can stall a request handler behind a forgotten interactive session. The lock_wait_limit_ms setting bounds the wait; the default of 0 disables the limit, and when a positive limit expires the statement fails with SQLSTATE 55P03. We set 3000 for web requests and a much shorter 200 for schema migrations, so that a migration gives up quickly instead of queueing every other query on the table behind its pending lock.

The related idle_txn_cutoff_s setting, 300 in our clusters, terminates sessions that sit idle inside an open transaction, the most common source of both long lock waits and sweeper backlog.

## Choosing a level

Use READ COMMITTED for simple single-statement work, REPEATABLE READ for reports that need a consistent view across several queries, and SERIALIZABLE wherever a transaction checks a condition and then writes based on it. The stronger levels cost retries, not correctness, and a retry loop is far cheaper than repairing data damaged by an unnoticed anomaly.
