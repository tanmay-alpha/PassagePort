# Migrating a Service from HTTP/1.1 to HTTP/2

This guide records what we learned moving the order-intake service behind the Larkspur edge proxy from HTTP/1.1 to HTTP/2. It covers the protocol differences that changed our operational habits and ends with the checklist we now use for every service. Settings are Larkspur 3.4 names.

## Why migrate

Under HTTP/1.1 a connection carries one request at a time. A slow response blocks everything queued behind it on that connection, so clients open many parallel connections, each paying for its own TCP and TLS setup and each starting with a small congestion window. HTTP/2 keeps the same methods, status codes and header semantics but changes how bytes are framed on the wire, allowing one connection to do the work of many.

## Multiplexed streams

Each request and its response travel on a stream, an independent sequence of frames identified by a number. Streams opened by the client use odd identifiers, and frames from different streams may be interleaved freely, so a slow response no longer delays a fast one that was requested later.

The number of streams a peer may have open at once is advertised in a settings frame. Larkspur exposes it as h2_max_concurrent_streams with a default of 128. A client that tries to exceed the limit has the extra stream rejected rather than queued. Size your worker pools with this in mind: where an HTTP/1.1 connection could deliver at most one request at a time, a single HTTP/2 connection can deliver 128 simultaneously, and backends sized by connection count were overwhelmed in our first test.

## Header compression with HPACK

HTTP/1.1 repeats the full text of every header on every request. HPACK shrinks this in two ways: common headers are referenced from a predefined static table, and each side of the connection builds a dynamic table of headers it has already sent, so a repeated cookie or authorization value costs one or two bytes after its first appearance. The dynamic table is bounded by h2_header_table_bytes, 4096 by default.

Two operational notes follow. First, compression state belongs to the connection, so a header block must be decoded even when its stream is rejected; skipping it corrupts every later request. Second, the total decoded header size is still limited, and Larkspur answers a request that exceeds h2_max_header_list_bytes (default 16384) with status 431.

## Flow control

Because many streams share one connection, a receiver needs a way to stop one large download from monopolizing its buffers. HTTP/2 gives each stream, and the connection as a whole, a window of bytes the sender may transmit. The receiver replenishes it with WINDOW_UPDATE frames as it consumes data. Only DATA frames count against the window; headers do not.

The protocol default window is 65535 bytes, which throttles large uploads on fast links because the sender stalls after every 64 KiB until an update arrives. We raised h2_stream_window_bytes to 1048576 for the upload path and saw transfer times for 50 MB objects drop by about a third. A window that is too large has the opposite risk: a slow consumer lets memory pile up in the proxy.

## GOAWAY and graceful shutdown

With long-lived multiplexed connections, closing a connection abruptly would kill dozens of unrelated requests. Instead a server sends a GOAWAY frame naming the last stream identifier it will process. Streams at or below that number run to completion; streams above it were never handled and the client may safely send them again on a new connection.

Larkspur sends GOAWAY when a worker begins draining and then waits h2_drain_grace_s, 20 seconds by default, before closing the socket. It also retires a connection after h2_max_connection_age_s, set to 900 in our deployment, so that long-lived clients are redistributed across backends after a scale-out instead of staying glued to the old instances.

## Stream error codes

A single stream can fail without harming the connection. The sender of a RST_STREAM frame includes an error code, and three of them matter for retry logic:

| Code | Name | Meaning for the client |
| --- | --- | --- |
| 0x7 | REFUSED_STREAM | Rejected before any processing; always safe to retry |
| 0x8 | CANCEL | The peer no longer wants the stream |
| 0xb | ENHANCE_YOUR_CALM | The peer considers the client abusive; back off |

REFUSED_STREAM is the important one. Because it guarantees that no application logic ran, even a non-idempotent request such as a payment POST can be resent. Our client library retries it up to 3 times with a fresh connection on the last attempt. Treating every reset as retryable, by contrast, caused duplicate orders in an early build.

## Head-of-line blocking that remains

HTTP/2 removes blocking between requests at the application layer, but all streams still ride a single TCP connection. When one packet is lost, TCP holds back every byte behind it until the retransmission arrives, and every stream on the connection pauses together. On lossy mobile networks a handful of HTTP/1.1 connections can actually outperform one HTTP/2 connection for this reason. We measured the effect becoming visible above roughly 2 percent packet loss.

## Negotiation with ALPN

Browsers and most clients use HTTP/2 only over TLS. The protocol is selected during the TLS handshake through the ALPN extension: the client lists the protocols it supports, the server picks one, and the connection speaks the token h2 or falls back to http/1.1 without an extra round trip. TLS 1.2 is the minimum version permitted.

Connection reuse creates one new failure mode. A client may reuse a connection for any hostname covered by the certificate, and may reach a server that is not configured for that hostname. The server should answer with status 421, Misdirected Request, which tells the client to retry on a separate connection.

## Rollout checklist

- Enable ALPN with both protocols on the edge first and confirm that old clients still negotiate HTTP/1.1.
- Size backend concurrency by streams, not by connections.
- Make clients retry on GOAWAY and REFUSED_STREAM only, and verify with a forced drain.
- Replace per-connection rate limits with per-stream or per-request limits.
- Watch the h2_streams_reset_total counter and p99 latency for one week at 10 percent of traffic before going to 100 percent.
- Keep the HTTP/1.1 listener available so a rollback is a configuration change and not a deployment.
