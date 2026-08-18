import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

if (!window.storage) {
  window.storage = {
    get: async (k) => {
      const value = localStorage.getItem(k);
      if (value === null) throw new Error("not found");
      return { key: k, value };
    },
    set: async (k, v) => { localStorage.setItem(k, v); return { key: k, value: v }; },
  };
}

createRoot(document.getElementById("root")).render(<App />);