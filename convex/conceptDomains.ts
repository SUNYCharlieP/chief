import { v } from "convex/values";

// Single source for the Three-Link Drill concept domains (JAR-38). Imported by
// the schema (concepts + reps tables) and the convex functions so the four
// domains can never drift between them. Same pattern as pendingActionKinds.
export const CONCEPT_DOMAINS = ["swift-arch", "saas-arch", "apple-dev", "arm"] as const;
export type ConceptDomain = (typeof CONCEPT_DOMAINS)[number];

export const domainValidator = v.union(
  v.literal("swift-arch"),
  v.literal("saas-arch"),
  v.literal("apple-dev"),
  v.literal("arm"),
);
