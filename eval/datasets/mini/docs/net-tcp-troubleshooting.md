# TCP Connection Troubleshooting Guide

This guide collects the failure patterns our network team sees most often on services that talk over TCP, together with the reasoning needed to tell them apart. Parameter names refer to the Brindle network stack shipped on our application hosts; other stacks have equivalents under different names. The sockpeek utility mentioned throughout prints the kernel's view of a single socket, including its state, queue depths and retransmission counters.

## The three-way handshake

A connection opens with three segments. The client sends SYN carrying its initial sequence number, the server answers SYN-ACK with its own, and the client completes the exchange with an ACK. Only after the third segment does the server side count as established.

If the first SYN gets no answer, the client retries with a doubling delay that starts at 1 second. The number of tries is tcp_syn_attempts, default 6, which means a connect call to a silent address gives up after roughly 63 seconds. Applications that need to fail faster should set their own connect deadline rather than lowering the system-wide value.

## Retransmission and timeouts

Every sent segment starts a retransmission timer computed from the measured round-trip time, with a floor of 200 milliseconds. When the timer fires without an acknowledgment, the segment is sent again and the timer doubles. Three duplicate acknowledgments trigger a fast retransmit without waiting for the timer, which is why isolated loss on a busy connection is usually repaired quickly while loss at the tail of a burst is slow.

The stack abandons a connection after tcp_retry_limit consecutive failed retransmissions. With the default of 15 that takes between 13 and 30 minutes depending on the path, far longer than most applications are willing to wait, so an application-level read deadline is still required.

## Keepalive

An idle connection exchanges no packets, so neither end notices if the other disappears or if a firewall in the middle forgets the flow. Keepalive probes solve this, but only when the application enables them on the socket. Three settings control the behavior:

- keepalive_idle_s: idle time before the first probe, default 7200 seconds
- keepalive_probe_gap_s: delay between unanswered probes, default 75 seconds
- keepalive_probe_count: unanswered probes before the connection is declared dead, default 9

The defaults mean a dead peer is detected after more than two hours. Many cloud load balancers silently drop idle flows after 350 seconds, so for connections crossing one we set the idle time to 120 seconds.

## Socket error codes

The four errors below are often lumped together as connection problems, but each points to a different cause.

ECONNREFUSED is returned by connect when the target host answers the SYN with a reset. The machine is reachable but nothing is listening on that port: the service is down, bound to a different address, or still starting. The fix lies on the server side or in the client's configured port; retrying immediately rarely helps.

ETIMEDOUT means packets went unanswered until the stack gave up. During connect it suggests a firewall silently discarding the SYN, a wrong route or a host that is powered off. On an established connection it means the retransmission limit or the keepalive probe budget was exhausted. Check packet filters and routing before blaming the application.

ECONNRESET appears when a reset segment arrives on an established connection. Typical causes are a peer process that crashed or closed the socket while unread data was still in its receive buffer, a peer that restarted and no longer knows the connection, or a middlebox that expired its state table entry. Clients using connection pools should discard the socket and retry idempotent requests on a fresh one, and should keep pooled connections for a shorter time than the server's idle limit.

EPIPE is raised on a write to a socket whose peer has already closed its end. The first write after the close usually succeeds and provokes a reset; it is the second write that fails, and by default the process also receives SIGPIPE, which terminates it unless the signal is ignored. The remedy is to read the peer's response or end-of-stream before sending more, and to handle the error instead of letting the signal kill the program.

| Error | Raised during | First thing to check |
| --- | --- | --- |
| ECONNREFUSED | connect | Is the listener running on that port |
| ETIMEDOUT | connect, read or write | Firewalls and routes |
| ECONNRESET | read or write | Peer restarts and idle expiry |
| EPIPE | write | Writing after the peer closed |

## Listen backlog sizes

A listening socket has two queues. Half-open connections that have received a SYN wait in the SYN queue, whose length is syn_queue_len, default 1024. Completed handshakes wait in the accept queue until the application calls accept; its length is the smaller of the backlog argument passed to listen and the system ceiling listen_backlog_cap, default 4096.

When the accept queue is full the stack drops the client's final ACK, and the client sees a slow or timed-out connect even though the server process looks healthy. A rising overflow counter in sockpeek -l means the application is accepting too slowly or the backlog is too small for the arrival burst.

## Nagle's algorithm

Nagle's algorithm holds back a small segment while earlier data is still unacknowledged, so that many tiny writes are combined into fewer packets. On its own this is harmless. Combined with delayed acknowledgments, where the receiver waits up to 40 milliseconds hoping to piggyback the ACK on a reply, it produces a stall: the sender waits for an ACK and the receiver waits for more data.

The symptom is request latency clustering near 40 milliseconds on protocols that write a header and a body separately. Either set the TCP_NODELAY socket option to disable the algorithm or, better, assemble the whole message and send it with one write call.

## Quick triage order

Confirm with sockpeek which state the socket is in, read the exact error code rather than the log message wrapped around it, and capture packets on both ends when the two sides disagree about who closed first.
