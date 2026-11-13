// A document the app's saving keeps that is not the browser store's own (lib/persistenceService.ts): another store
// describes it, and says when it changed.

/** A document another store keeps, and the app's saving writes. */
export type SavedDocument = {
  /** The document's name on disk. */
  readonly name: string;
  /** What the document holds now. */
  readonly json: () => string;
  /** Tells the saving when the document may have changed. The answer stops the watch. */
  readonly watch: (changed: () => void) => () => void;
};
