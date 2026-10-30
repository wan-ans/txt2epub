import { createApp } from "vue";
import App from "./App.vue";
import "./styles/tokens.css";
import "./styles/app.css";
import { initUiLanguage } from "./components/composables/useUiLanguage";

initUiLanguage();
createApp(App).mount("#app");
