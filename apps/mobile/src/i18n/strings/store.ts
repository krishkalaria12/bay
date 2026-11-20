// The strings the saved model and the store show the user: the names they give their spaces and folders, and the
// words they use when something they saved can't be read back.

export const store = {
  // The spaces and folders the model names (model.ts, store/browser.ts).
  "space.personal": "Personal",
  "space.default": "Space {index}",
  "space.unnamed": "Space",
  "space.edit.title": "Edit {name}",
  "space.edit.name": "Name",
  "space.edit.color": "Colour",
  "space.edit.icon": "Emoji",
  "space.edit.order": "Order",
  "space.edit.moveLeft": "Move left",
  "space.edit.moveRight": "Move right",
  "space.edit.delete": "Delete {name}",
  "space.edit.delete.detail": "Its tabs, pins, history, bookmarks and sign-ins go with it",
  "space.edit.delete.personal": "Personal syncs with your computer, so it stays",
  "space.edit.delete.title": "Delete {name}?",
  "space.edit.delete.message": "Its tabs, pinned sites, history, bookmarks and website sign-ins are deleted. This can't be undone.",
  "space.edit.delete.cancel": "Cancel",
  "space.edit.delete.action": "Delete",
  "space.color.blue": "Blue",
  "space.color.green": "Green",
  "space.color.orange": "Orange",
  "space.color.red": "Red",
  "space.color.violet": "Violet",
  "space.color.gray": "Grey",

  // The saved document (model.ts).
  "state.unreadable": "The saved browsing state could not be read.",
  "downloads.interrupted": "Bay closed before it finished.",

  // The errors Bay kept (crashReports.ts).
  "crash.none": "Bay has not crashed since it was last opened.",
};

/** Every locale's slice carries exactly these keys, so a missing translation is a type error. */
export type StoreStrings = Record<keyof typeof store, string>;
