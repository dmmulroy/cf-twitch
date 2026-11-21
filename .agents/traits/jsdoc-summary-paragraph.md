---
name: jsdoc-summary-paragraph
subject: The first paragraph of JSDoc comments.
requirement: Each JSDoc comment opens with a single summary paragraph. For a
  function or method it starts with a present-tense verb such as `Creates`,
  `Returns`, `Parses`, or `Provides`; for a value, type, resource, or field it
  starts with a noun phrase such as `Zone ID of`, `Layer that`, or `Schema for`.
purpose: Makes the comment readable and findable from its first line. The best
  summaries also state the fact the signature cannot show, in the domain words a
  reader would search for.
---
Compliant:

```ts
/** Parses an email address received at an external input boundary. */
/** Cloudflare zone ID of `mulroy.cloud`, pinned so plans can diff records before the zone resolves. */
/** Layer that provides the sightings repository over the Worker's D1 and R2 bindings. */
```

Violation: the opening is not one verb- or noun-led paragraph.

```ts
/** This is used for DNS. It holds the zone id, see the stack too. */
/** The function that parses an email. */  // function summary led by a noun phrase
```