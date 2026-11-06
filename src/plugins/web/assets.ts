import markdownParser from "../../../node_modules/marked/lib/marked.umd.js" with { type: "text" };
import markdownRenderer from "./markdown.js.txt" with { type: "text" };
import page from "./page.html.txt" with { type: "text" };
import script from "./app.js.txt" with { type: "text" };
import style from "./style.css.txt" with { type: "text" };
export { page, script, style, markdownParser, markdownRenderer };
