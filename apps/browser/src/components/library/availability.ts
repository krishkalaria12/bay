import { hasNativeModule } from "@bay/platform";
import { hasServiceClient } from "../../runtime/serviceClient";

/** Library and Easels need the native canvas and a local persistence owner. */
export const libraryAvailable = () => !hasServiceClient() && hasNativeModule("BayEasel");
