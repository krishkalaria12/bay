import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".")) {
        try {
          return next(specifier + ".ts", context);
        } catch {}
      }
      throw error;
    }
  },
});
