---
name: refactor-codebase-with-types
description: Finds refactoring opportunities that replace validation, partial functions, unsafe casts, primitive obsession, and scattered invariants with parsing, precise domain types, and correct-by-construction data. Use when the user wants to refactor a codebase using type-driven design, make illegal states unrepresentable, parse inputs at boundaries, remove redundant checks, or improve static guarantees.
---

# Refactor Codebase with Types

Surface refactoring opportunities inspired by Alexis King's “Parse, don't validate” and “Types as axioms.” The aim is to move facts learned at runtime into values and types so valid states are easy to construct, invalid states are hard or impossible to represent, and execution code stops re-checking things boundary code already proved.

## Glossary

Use these terms exactly in suggestions. Full definitions are in [LANGUAGE.md](LANGUAGE.md).

- **Boundary** — where less-structured outside data enters the program.
- **Parser** — code that consumes less-structured input and produces more-structured output or a typed failure.
- **Validator** — code that checks a fact but throws away the evidence, often returning `void`, `()`, `boolean`, or raising.
- **Evidence** — a value/type that preserves a checked fact for later code.
- **Precise representation** — a datatype that encodes the facts downstream code depends on.
- **Illegal state** — a value shape the domain or algorithm cannot correctly handle.
- **Correct by construction** — a representation whose constructors preserve the invariant.
- **Partial function** — code whose signature promises more than it can deliver for all inputs.
- **Burden of proof** — the obligation to establish a precondition before execution can proceed.
- **Shotgun parsing** — validation scattered through processing code.
- **Axiom** — a constructor or factory that introduces a valid base case.
- **Inference rule** — a constructor or operation that preserves validity when building more values.

## Principles

- **Parse, don't validate.** Checks should produce **evidence** callers must use, not discard facts.
- **Make illegal states unrepresentable.** Prefer data shapes where bad states cannot be constructed.
- **Strengthen arguments before weakening results.** If a function needs non-empty input, accept `NonEmpty`-like input rather than returning “maybe” from a too-broad input.
- **Push the burden of proof upward, but no further.** Parse at the **boundary** or immediately after the control-flow branch that requires the stronger fact.
- **Separate parsing from execution.** Invalid input failures belong before stateful processing whenever practical.
- **Design positive space.** Ask “what constructors build only valid values?” before asking “what restrictions exclude bad values?”
- **Treat escape hatches as radioactive.** `any`, casts, `!`, `unwrap`, `as`, `error("impossible")`, and unchecked exceptions in connective tissue stop evidence from propagating.

## Process

### 1. Explore

Read the project's domain glossary (`CONTEXT.md`) and relevant ADRs first, if present. Then inspect code organically for places where runtime knowledge fails to survive in the program shape:

- Validators returning no useful value: `void`, `()`, `boolean`, exceptions, logs, assertions.
- Partial functions: unchecked indexing, `head`, `first`, `unwrap`, nullable access, impossible branches.
- Primitive obsession: strings/numbers/maps/arrays carrying domain facts in comments or names.
- Scattered checks for the same invariant across call sites.
- Boundary code that passes raw JSON/HTTP/env/DB/CLI data deep into execution.
- Denormalized mutable state where duplicated facts can drift out of sync.
- Unsafe casts or broad types in central modules that prevent type information from flowing.

### 2. Present candidates

Present a numbered list of refactoring opportunities. For each candidate include:

- **Files** — the relevant files/modules.
- **Invariant** — the fact currently checked informally or repeatedly.
- **Problem** — how the current representation loses evidence or permits illegal states.
- **Refactor** — the parser, precise representation, constructor/factory, or sum type to introduce.
- **Proof movement** — where the burden of proof moves and which checks disappear downstream.
- **Risks** — conversion cost, ergonomics, performance, compatibility, or language limitations.

Do not implement yet. Ask: “Which of these would you like to explore or apply?”

### 3. Design the selected refactor

For the selected candidate, walk the design tree with the user:

- Define the exact **illegal states** to eliminate.
- Choose a **precise representation** using existing language idioms: branded/newtypes, opaque classes, discriminated unions, enums, value objects, ADTs, result types, smart constructors, or schemas that return typed values.
- Identify the **parser** and its typed failure shape.
- Decide where raw values are still allowed and where only parsed values may cross.
- List downstream code that becomes total, simpler, or unreachable.
- Keep the representation proportional: prefer small local types over elaborate encodings unless the invariant is central.

### 4. Apply carefully

When implementing:

- Add the parser/constructor first, with tests for accepted and rejected inputs.
- Change one consuming function to accept the precise type it wishes it had.
- Follow compile/type/test failures upward until you reach the correct boundary or branch point.
- Delete redundant validation after evidence is available.
- Keep unavoidable unsafe operations in tiny, named, documented modules.
- Update `CONTEXT.md` if the refactor names a domain concept not yet recorded.
