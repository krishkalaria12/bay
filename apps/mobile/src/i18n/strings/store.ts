// The strings the saved model and the store show the user: the names they give their spaces and folders, and the
// words they use when something they saved can't be read back.

export const store = {
  // The spaces and folders the model names (model.ts, store/browser.ts).
  "space.personal": "Personal",
  "space.default": "Space {index}",
  "space.unnamed": "Space",

  // The saved document (model.ts).
  "state.unreadable": "The saved browsing state could not be read.",
  "downloads.interrupted": "Bay closed before it finished.",

  // The errors Bay kept (crashReports.ts).
  "crash.none": "Bay has not crashed since it was last opened.",
};

/** Every locale's slice carries exactly these keys, so a missing translation is a type error. */
export type StoreStrings = Record<keyof typeof store, string>;
