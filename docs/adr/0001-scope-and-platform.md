# ADR 0001: Original-content MVP and modular platform

Status: Accepted | Date: 2026-09-11

Context: The repository contains a broad third-party-lore product concept and no application. The portfolio needs credible operations evidence within a small time and credit envelope.

Decision: Build one original WHO case, guest sessions and one cache-warming job. Separate engine from content. Use a TypeScript monorepo with React/Vite, Express, PostgreSQL, Redis/BullMQ and four apps. Build local containers before kind/Helm/Argo CD, then observability and only conditionally AWS. Ownership boundaries are defined in the architecture baseline.

Alternatives: Multiple case types and third-party content multiply product and rights risks. A single cheap managed application host would be simpler for this traffic; Kubernetes is chosen specifically to practice delivery, drift repair, probes, scaling and recovery. Microservices would add distributed consistency work without product value.

Consequences: Operational complexity is intentional and must produce measured evidence. The project does not claim Kubernetes is cost-optimal. Original fixtures must be authored; historical narrative is excluded from build/demo content. No account recovery or permanent hosting promise exists. Optional polish and cloud recovery are first to be cut if milestones slip.

Verification: S1 original-content inventory; S2 deterministic command surface; S8 clean-volume integration; S9 fresh-clone platform. Supersede this ADR to expand case types, add durable jobs or change platform boundaries.
