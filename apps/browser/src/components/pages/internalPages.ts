// What an internal page's address says, with nothing that needs the app running: store and lib code can read it.
// The coordinator's store owns it (store/internalPages.ts); this path stays for the component imports built on it.
export {
  INTERNAL_PAGES,
  INTERNAL_SCHEME,
  internalUrl,
  internalPageOf,
  internalQuery,
  tabDestination,
  isInternalTab,
  type InternalPageId,
} from "../../store/internalPages";
