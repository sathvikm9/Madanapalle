import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { registerMplServiceWorker } from "./notifications.js";
import "./styles.css";

void registerMplServiceWorker();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
