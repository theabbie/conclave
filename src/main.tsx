import { createRoot } from "react-dom/client";
import { BoardStore } from "./board/store";
import { App } from "./App";
import "./styles.css";

try {
  const store = new BoardStore(localStorage);
  createRoot(document.getElementById("root")!).render(<App store={store} />);
} catch (error) {
  createRoot(document.getElementById("root")!).render(
    <div className="startup-error">
      <h1>Your board couldn't be opened.</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <p>
        Your saved data has not been replaced. Check browser storage access and
        reload.
      </p>
    </div>,
  );
}
