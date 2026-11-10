import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import session from "express-session";
import bcrypt from "bcryptjs";
import { User, Room, Request } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_LOGIN = "Conf2027";

// 1. Парсинг форм
app.use(express.urlencoded({ extended: true }));

// 2. Статика
app.use(express.static(join(__dirname, "public")));

// 3. Настройка EJS
app.set("view engine", "ejs");
app.set("views", join(__dirname, "views"));

// 4. Сессия
app.use(
  session({
    secret: "conf2027-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 2, // 2 часа
      httpOnly: true,
      sameSite: "lax",
    },
  }),
);

// 5. Проброс сессии в шаблоны
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// 6. Проверка бездействия (20 минут)
const INACTIVITY_LIMIT = 20 * 60 * 1000;
app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    const now = Date.now();

    if (
      req.session.lastActivity &&
      now - req.session.lastActivity > INACTIVITY_LIMIT
    ) {
      return req.session.destroy(() => {
        res.redirect("/login");
      });
    }

    req.session.lastActivity = now;
  }
  next();
});

// 7. Мидлвары доступа
const requireAuth = (req, res, next) =>
  req.session.userId ? next() : res.redirect("/login");

const requireAdmin = (req, res, next) =>
  req.session.login === ADMIN_LOGIN ? next() : res.redirect("/login");

// 8. Валидация регистрации
const RULES = [
  {
    field: "login",
    test: (v) => /^[A-Za-z0-9]{6,}$/.test(v),
    msg: "Логин: латиница+цифры, минимум 6 символов",
  },
  {
    field: "password",
    test: (v) => v && v.length >= 8,
    msg: "Пароль: минимум 8 символов",
  },
  {
    field: "fio",
    test: (v) => /^[А-Яа-яЁё\s]+$/.test(v),
    msg: "ФИО: только кириллица и пробелы",
  },
  {
    field: "phone",
    test: (v) => /^8\(\d{3}\)\d{3}-\d{2}-\d{2}$/.test(v),
    msg: "Телефон: формат 8(ХХХ)ХХХ-ХХ-ХХ",
  },
  {
    field: "email",
    test: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
    msg: "Email: некорректный формат",
  },
];

const validate = (data) =>
  RULES.filter(({ field, test }) => !test((data[field] || "").trim())).map(
    (r) => r.msg,
  );

const PAYMENTS = ["При очном посещении", "Перевод по СБП"];
const STATUSES = ["Новая", "Мероприятие назначено", "Завершено"];

// 9. Маршруты
app.get("/", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  res.redirect(req.session.login === ADMIN_LOGIN ? "/admin" : "/dashboard");
});

app.get("/auth", (req, res) => {
  res.redirect("/login");
});

app.get("/register", (req, res) => {
  res.render("auth", {
    mode: "register",
    form: {},
    errors: [],
  });
});

app.post("/register", (req, res) => {
  const data = {
    login: (req.body.login || "").trim(),
    password: req.body.password || "",
    fio: (req.body.fio || "").trim(),
    phone: (req.body.phone || "").trim(),
    email: (req.body.email || "").trim(),
  };

  const errors = validate(data);

  if (User.exists(data.login)) {
    errors.push("Логин уже занят");
  }

  if (errors.length) {
    return res.render("auth", {
      mode: "register",
      form: req.body,
      errors,
    });
  }

  User.create(data);

  req.session.flash = {
    type: "success",
    text: "Регистрация успешна. Войдите.",
  };

  res.redirect("/login");
});

app.get("/login", (req, res) => {
  const flash = req.session.flash || null;
  delete req.session.flash;

  res.render("auth", {
    mode: "login",
    error: null,
    flash,
  });
});

app.post("/login", (req, res) => {
  const user = User.findByLogin((req.body.login || "").trim());

  if (user && bcrypt.compareSync(req.body.password || "", user.password)) {
    req.session.userId = user.id;
    req.session.fio = user.fio;
    req.session.login = user.login;
    req.session.lastActivity = Date.now();

    return res.redirect(
      user.login === ADMIN_LOGIN ? "/admin" : "/dashboard",
    );
  }

  res.render("auth", {
    mode: "login",
    error: "Неверный логин или пароль",
    flash: null,
  });
});

app.all("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/rooms", (req, res) => {
  res.render("rooms", { rooms: Room.findAll() });
});

app.get("/rooms/type/:type", (req, res) => {
  res.render("rooms", { rooms: Room.findByType(req.params.type) });
});

app.get("/dashboard", requireAuth, (req, res) => {
  const requests = Request.findByUser(req.session.userId);
  res.render("requests_list", { isAdmin: false, requests });
});

app.get("/admin", requireAdmin, (req, res) => {
  const requests = Request.findAllDetailed();
  res.render("requests_list", { isAdmin: true, requests });
});

app.post("/admin", requireAdmin, (req, res) => {
  if (STATUSES.includes(req.body.status)) {
    Request.updateStatus(req.body.id, req.body.status);
  }
  res.redirect("/admin");
});

app.get("/create", requireAuth, (req, res) => {
  res.render("create_request", {
    rooms: Room.findAll(),
    errors: [],
  });
});

app.post("/create", requireAuth, (req, res) => {
  const { room_id, date_start, payment } = req.body;
  const room = Room.findById(room_id);
  const errors = [];

  if (!room) errors.push("Выберите помещение");
  if (!date_start) errors.push("Укажите дату начала конференции");
  if (!PAYMENTS.includes(payment)) errors.push("Выберите способ оплаты");

  if (errors.length) {
    return res.render("create_request", {
      rooms: Room.findAll(),
      errors,
      form: req.body,
    });
  }

  Request.create({
    userId: req.session.userId,
    roomId: room.id,
    dateStart: date_start,
    payment,
  });

  res.redirect("/dashboard");
});

app.get("/request/:id", requireAuth, (req, res) => {
  const request = Request.findDetailed(req.params.id);

  if (!request) {
    return res.status(404).send("Заявка не найдена");
  }

  const isOwner = request.user_id === req.session.userId;
  const isAdmin = req.session.login === ADMIN_LOGIN;

  if (!isOwner && !isAdmin) {
    return res.status(403).send("Доступ запрещён");
  }

  res.render("request_detail", {
    request,
    isOwner,
    isAdmin,
  });
});

app.post("/review/:id", requireAuth, (req, res) => {
  const request = Request.findDetailed(req.params.id);

  if (!request) {
    return res.status(404).send("Заявка не найдена");
  }

  if (request.user_id !== req.session.userId) {
    return res.status(403).send("Только владелец может оставить отзыв");
  }

  const review = (req.body.review || "").trim();
  Request.addReview(request.id, req.session.userId, review);

  res.redirect(`/request/${request.id}`);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
