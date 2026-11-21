---
name: faithful-verification
subject: Test cases in test files (`*.test.ts`) and other verification of
  application behavior.
requirement: Tests exercise behavior through public interfaces with real or
  behaviorally faithful implementations, and each test states exactly which
  behavior it proves.
applicability: Source files without tests are not subjects.
purpose: Gives tests that catch real regressions rather than confirming mocks.
---
Faithful implementations include SQLite for SQLite behavior, `TestClock` for time, in-memory Layers that cross the same service interface, and controlled providers for external effects. Exercise dependencies through their service or runtime interface rather than by mocking their module.