# 🧠 Piko

A lightweight, modern **Express alternative** made by **IdiotStudios**.
Designed to be simple, fast, and fully compatible with the familiar Express API.

```js
import piko from "piko";

const app = piko();

app.get("/", (req, res) => res.send("Hello from Piko!"));
app.listen(3000);
```

## 🚀 Features

* Express-like API (`req`, `res`, `next`)
* Middleware, Routers, Params
* Built-in JSON + Static middleware
* Zero dependencies
* ESM-first design

## 💡 Contributing

Open issues and PRs are welcome!
Let's make **Piko** a great Express alternative together!

👉 [IdiotStudios on GitHub](https://github.com/IdiotStudios)
