const menuBtn = document.getElementById("menuBtn");
const mainNav = document.getElementById("mainNav");

menuBtn?.addEventListener("click", () => {
  mainNav.classList.toggle("open");
});

mainNav?.querySelectorAll("a").forEach(link => {
  link.addEventListener("click", () => mainNav.classList.remove("open"));
});

document.getElementById("year").textContent = new Date().getFullYear();

const quotes = [
  "“El futuro no se encuentra: se construye.”",
  "“Un país también se transforma cuando cambia las preguntas que se hace.”",
  "“La imaginación es una forma de infraestructura.”",
  "“El Edén no es un lugar perfecto: es un proyecto.”",
  "“Chile puede copiar modelos; también puede inventar los propios.”"
];

const quote = document.getElementById("dailyQuote");
if (quote) {
  quote.textContent = quotes[Math.floor(Math.random() * quotes.length)];
}