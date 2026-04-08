import "./styles.css";
import { render } from "preact";
import { App } from "./App";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;
const logoUri = root.dataset.logo ?? "";

render(<App vscode={vscode} logoUri={logoUri} />, root);
