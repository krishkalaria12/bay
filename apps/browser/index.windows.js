import "react-native";
import { nativeApiSkew, startSkewed } from "./src/nativeApi";

if (nativeApiSkew) startSkewed(nativeApiSkew);
else require("./src/main");
