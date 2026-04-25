---
title: Welcome
description: testing-os handbook — centralized dogfood governance for mcp-tool-shop-org
sidebar:
  order: 0
---

testing-os is the centralized dogfood evidence system for mcp-tool-shop-org. It proves, with auditable evidence, that each repo was actually exercised in a dogfood-worthy way.

## What This System Does

- **Source repos** define scenarios and run dogfood workflows
- **Central verifier** validates schema, provenance, and policy compliance
- **Accepted records** are persisted with full audit trail
- **Generated indexes** make dogfood status queryable across the org

## Key Concepts

| Concept | What It Means |
|---------|---------------|
| **Record** | A structured JSON document proving a dogfood run happened |
| **Scenario** | A YAML definition of what constitutes real exercise |
| **Policy** | Per-repo rules governing enforcement and freshness |
| **Surface** | The product type being dogfooded (CLI, desktop, web, etc.) |
| **Finding** | An evidence-bound lesson extracted from dogfood runs |
| **Pattern** | A repeated lesson cluster backed by 2+ accepted findings |
| **Doctrine** | A hardened portfolio rule earned from repeated patterns |

## Current Coverage

13 repos across 8 product surfaces, all verified pass, all enforcement: required.

## Getting Started

- [Beginner's Guide](./beginners/) -- new to testing-os? start here
- [Architecture](./architecture/) -- how the system works
- [Contracts](./contracts/) -- the seven defining contracts
- [Operating Guide](./operating-guide/) -- day-to-day operations
- [Integration](./integration/) -- how other systems consume dogfood status
- [Intelligence Layer](./intelligence-layer/) -- how evidence becomes reusable portfolio memory
