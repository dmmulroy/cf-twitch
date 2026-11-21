---
name: option-for-optional-values
subject: Optional fields, properties, parameters, and return values inside the
  application.
requirement: Inside the application, optional values are represented with
  `Option.Option<A>`. Nullable or optional external input is decoded into
  `Option` at the boundary and encoded back only where an external contract
  requires `null`, `undefined`, or an omitted property.
applicability: Boundary, platform, generated, declaration, test, and fixture
  contracts may use nullish values; convert them where they enter an inner
  module.
purpose: Makes absence explicit and handled consistently.
---
```ts
import { Option } from "effect";

type Issue = { body: Option.Option<string> };

const withBody = Option.some("Issue details");
const withoutBody = Option.none<string>();
```