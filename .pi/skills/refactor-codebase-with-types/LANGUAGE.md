# Language

Shared vocabulary for type-driven refactoring suggestions. Use these terms consistently.

## Terms

**Boundary**
Where less-structured outside data enters the program: HTTP requests, JSON, CLI flags, environment variables, database rows, files, message queues, user input, or untyped library callbacks.

**Parser**
Code that consumes less-structured input and produces more-structured output, or a typed failure. A parser preserves what it learned by returning **evidence**. It does not have to parse text; converting `T[]` to `NonEmpty<T>` or raw config to `Config` counts.

**Validator**
Code that checks a fact but discards the evidence. Common smells: returns `void`, `()`, `boolean`, mutates an error list, logs and continues, throws without producing a refined value, or has a name like `validateX` while callers continue using the original raw value.

**Evidence**
A value or type that carries a checked fact forward. Examples: `NonEmpty<T>`, `EmailAddress`, `ParsedConfig`, `AuthenticatedRequest`, `Result<DomainValue, ParseError>`, a discriminated union case, an opaque/branded primitive, or an object whose constructor enforces an invariant.

**Precise representation**
A data representation that matches what downstream code actually needs. It may be a stronger type, an enum/sum type, a map instead of tuples, a non-empty collection, a normalized model, an opaque value object, or a state-specific record.

**Illegal state**
A value shape that the domain or algorithm cannot handle correctly: empty where non-empty is required, duplicate keys, invalid combinations of flags, impossible lifecycle states, mismatched denormalized values, unauthenticated data in authenticated code, unchecked nullable values.

**Correct by construction**
A representation whose public constructors/factories only create valid values, and whose operations preserve that validity. Think of constructors as axioms and operations as inference rules.

**Partial function**
Code whose apparent signature promises more than it can deliver for all possible inputs. It relies on hidden preconditions, throws for ordinary cases, uses unchecked indexing, assumes nullable values are present, or has “should never happen” branches.

**Burden of proof**
The obligation to establish a precondition before execution can safely proceed. Good refactors move this burden upward to a boundary or branch point and encode the result as evidence.

**Shotgun parsing**
Validation mixed into processing code across many call sites. It makes it hard to know whether invalid input was rejected before any effects occurred.

**Axiom**
A constructor, factory, or literal case that introduces a valid base value. Example: `EmptyEvenList` is an axiom for an even-length list.

**Inference rule**
A constructor or operation that preserves an invariant when deriving a new value from valid values. Example: adding two elements to an even-length list preserves evenness.

## Principles

- **Parse, don't validate.** If a check matters, return evidence from it and make callers consume that evidence.
- **Prefer total functions.** Change inputs so the function can keep its promise, or explicitly model failure in the result when failure is part of the domain.
- **Strengthen arguments before weakening results.** Prefer accepting a precise representation over returning optional/error values from a broad representation when the caller can prove the precondition earlier.
- **Push proof upward, but no further.** Establish facts at boundaries when possible; if only one branch needs a stronger fact, parse as soon as that branch is selected.
- **Design positive space.** Model the values you can construct validly instead of adding post-hoc restrictions to exclude invalid values.
- **Use ordinary language features first.** Branded primitives, opaque classes, enums, discriminated unions, smart constructors, result types, and collection choices often capture enough evidence.
- **Minimize escape hatches.** Unsafe casts, broad `any`/`unknown`, nullable assertions, unchecked unwraps, and impossible errors are acceptable only when small, named, documented, and isolated.
- **Avoid denormalized mutable evidence.** Duplicated facts create representable drift. If denormalization is necessary, hide it behind a module that maintains the invariant.

## Candidate heuristics

Prefer candidates where the invariant is central, repeated, bug-prone, security-sensitive, or sits in connective tissue. Be cautious where a precise representation would cause broad churn for a one-off check, duplicate standard library behavior, or make interoperability painful without clear payoff.

## Rejected framings

- **“Types are just restrictions.”** This skill treats types as ways to construct evidence and encode domain facts, not merely ways to reject values.
- **“Validation is always bad.”** Validation is fine when its result is evidence or when the check is a side-effecting guard with no reusable fact. The smell is discarding facts that downstream code needs.
- **“Every invariant belongs in the type system.”** Keep encodings proportional. Some invariants are better documented, tested, or isolated than encoded with complex type machinery.
