import "./styles.css";
import { DesktopApp } from "./app/DesktopApp";

const root = document.getElementById("app");

if (!root) {
  throw new Error("App root not found");
}

void new DesktopApp(root).boot();
