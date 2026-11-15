# Networking notes: TCP connection handling

## Three-way handshake

A TCP connection starts with a three-way handshake. The client sends SYN, the server answers
SYN-ACK, and the client completes the exchange with ACK. Only then can either side send data.

## Connection resets

`ECONNRESET` means the peer closed the connection abruptly by sending a RST segment. Common causes
are a crashed server process, an idle timeout on a load balancer, or writing to a socket the other
side has already closed. Retrying is safe only for idempotent requests.

## Congestion control

TCP slows down when it detects packet loss. Slow start doubles the congestion window every round
trip until the threshold `ssthresh` is reached, after which congestion avoidance grows the window
by one segment per round trip. A loss detected by three duplicate ACKs halves the window.

## Keep-alive

HTTP keep-alive reuses one TCP connection for several requests, which avoids repeating the
handshake. Servers usually close idle connections after 60 seconds.
