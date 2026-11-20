---
name: schema-tests-cover-owned-behavior
subject: Test cases in test files (`*.test.ts`) that target Schema definitions.
requirement: Schema-focused tests verify application-owned behavior beyond the
  declaration, such as a transformation, normalization, custom filter,
  compatibility contract, encoded/decoded round trip, or previously regressed
  edge case.
applicability: Source files that declare schemas are not subjects. The
  declaration is the specification for straightforward brands, structs, and
  unions.
purpose: Keeps tests focused on behavior the application owns rather than
  restating library mechanics.
---
When parse failures produce caller-visible outcomes, test them through the boundary's public interface.