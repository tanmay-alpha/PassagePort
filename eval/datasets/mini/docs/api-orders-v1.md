# Larkspur Orders API - Version 1 Specification

The Larkspur Orders API lets merchant systems create, read, and cancel orders on the Larkspur commerce platform. This document specifies version 1 of the API. All requests are sent over HTTPS to the base path /v1, and all request and response bodies are JSON encoded as UTF-8. Larkspur is a fictional platform invented for this specification, and nothing here describes a real service.

## Authentication

Every request must carry an API key in the `X-Larkspur-Key` header. Keys are created in the merchant console and are shown only once, at creation time. A key that is sent in a query string is rejected, because query strings tend to end up in proxy logs.

For browser-facing integrations, a server can exchange its API key for a short-lived session token by calling POST /v1/tokens. A session token is valid for 30 minutes and cannot be renewed; the client must request a new one before the old one expires.

A request with a missing or unknown key receives HTTP 401 with the error code auth_key_invalid. A key that exists but has been disabled by the merchant receives HTTP 403 with the error code auth_key_disabled. Version 1 keys have full access to every endpoint, and there is no way to restrict a key to read-only use.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /v1/orders | Create an order |
| GET | /v1/orders | List orders, newest first |
| GET | /v1/orders/{order_id} | Retrieve one order |
| POST | /v1/orders/{order_id}/cancel | Cancel an order |
| GET | /v1/orders/{order_id}/invoice | Download the invoice |

An order object contains the fields order_id, status, currency, line_items, and total_amount. The total_amount field is an integer in minor units, so 1999 means 19.99 in a two-decimal currency.

The status field takes one of the values pending, paid, shipped, or cancelled. An order can be cancelled only while its status is pending or paid. Cancelling a shipped order returns HTTP 409 with the error code order_not_cancellable.

The invoice endpoint returns a PDF rendering of the order and is the only endpoint that does not return JSON. Invoices become available about two minutes after an order reaches the paid status.

## Pagination

List endpoints return results in pages. The page size is controlled by the limit parameter, which defaults to 25 and may not exceed 100.

The position in the list is selected with the page parameter, a one-based page number. Each response includes total_count, the number of matching orders, and has_more, a boolean that tells the client whether another page exists.

## Rate Limiting

Each API key may make 100 requests per minute. The limit is counted over a sliding window of 60 seconds and is shared by all endpoints, so a burst of list calls reduces the budget left for order creation.

When the limit is exceeded, the API responds with HTTP 429 and the error code rate_limit_exceeded. The response carries a Retry-After header giving the number of seconds to wait before the next attempt.

Every response includes the headers X-RateLimit-Limit and X-RateLimit-Remaining so that a client can slow down before it is rejected. Order creation has an additional ceiling of 10 requests per second per key, which protects the payment processor from sudden spikes.

## Errors and Idempotency

Errors use ordinary HTTP status codes together with a JSON body. The code field is a stable machine-readable string, the message field is human-readable text that may change without notice, and request_id identifies the call when contacting support.

```
{"error": {"code": "order_not_found", "message": "No such order.", "request_id": "req_8Hq2", "details": {}}}
```

Validation failures return HTTP 400 with the error code invalid_request, and the details object maps each rejected field to a reason.

To make retries safe, POST requests accept an Idempotency-Key header containing a client-generated string of up to 64 characters. The first response for a key is stored for 24 hours and replayed for any repeat of the same request. If a stored key arrives again with a body that differs from the original, the API refuses the call with HTTP 422 and the error code idempotency_key_reused.

## Webhooks

Merchants can register HTTPS endpoints that receive event notifications. Version 1 emits the events order.created, order.paid, and order.cancelled. Each delivery is a POST request whose body contains the event type, a unique event_id, and the full order object.

Deliveries are signed with HMAC-SHA256 using the endpoint secret, and the signature is sent in the `X-Larkspur-Signature` header.

An endpoint must answer with a 2xx status within 10 seconds. A failed delivery is retried up to 5 times with exponential backoff, starting at 30 seconds and doubling after each attempt. An endpoint that fails every delivery for three consecutive days is disabled automatically and the merchant is notified by email.

## Sandbox Environment

Version 1 offers a sandbox at the base path /v1/sandbox for integration testing. Sandbox keys start with the prefix lk_test_ and cannot touch live orders, and live keys are rejected by sandbox endpoints.

No money moves in the sandbox. A payment made with the test card number ending in 0005 always succeeds, and one ending in 0119 always fails with the error code card_declined. All sandbox data is wiped every Sunday at 02:00 UTC, so test fixtures must be recreated at the start of each week.

## Deprecation Policy

Larkspur treats a change as breaking if it removes or renames a field, removes an endpoint, changes an error code, or tightens validation. Breaking changes are released only in a new major version. Adding optional fields, new endpoints, or new event types is not considered breaking, and clients must ignore fields they do not recognize.

A major version remains supported for at least 18 months after its successor is published. The retirement date is announced at least six months ahead, and from that announcement onward every response of the retiring version carries a Sunset header with the planned shutdown date. After shutdown, calls to a retired version return HTTP 410 with the error code version_retired.
