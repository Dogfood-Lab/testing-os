/**
 * Synthesis layer exports.
 */
export { derivePatterns } from './pattern-derivation.js';
export { deriveRecommendations, loadAcceptedPatterns, loadAcceptedPatternsWithSkips } from './recommendation-derivation.js';
export { deriveDoctrine } from './doctrine-derivation.js';
export { validatePattern, validateRecommendation, validateDoctrine } from './validate-artifacts.js';
export {
  writePattern, writeRecommendation, writeDoctrine,
  writePatterns, writeRecommendations, writeDoctrines,
  loadPatterns, loadRecommendations, loadDoctrines,
  loadPatternsWithSkips, loadRecommendationsWithSkips, loadDoctrinesWithSkips,
  resetSeenArtifactWrites
} from './write-artifacts.js';
export { dedupeArtifactsAgainstExisting } from './dedupe-artifacts.js';
