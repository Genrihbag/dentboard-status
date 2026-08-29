#!/usr/bin/env bash
# УСТАНОВКА НАБЛЮДАТЕЛЯ НА ОТДЕЛЬНУЮ МАШИНУ. Запускать на ней, из-под root.
#
# 🔴 ЗАЧЕМ ПЕРЕЕЗД С МАШИН GITHUB — ЗАМЕР 29.08.2026. `cron: */5` обещал двенадцать прогонов в час,
# по журналу случился ОДИН. Расписание у GitHub «best effort»: запуски задерживаются, а при нагрузке
# отбрасываются вовсе. Обойти это циклом внутри задания получилось, но зависимость осталась: пока
# смена не заступила, наблюдения нет.
#
# ⚠️ ГЛАВНОЕ ТРЕБОВАНИЕ ПРИ ЭТОМ НЕ ИЗМЕНИЛОСЬ: наблюдатель обязан быть ВНЕ наблюдаемой машины.
# 28.08.2026 боевой сервер был недоступен снаружи 2 ч 29 мин, а всё внутреннее наблюдение
# рапортовало здоровье — и было право, изнутри всё работало. Ставить этот скрипт на боевой сервер
# нельзя: получится уведомитель, который молчит вместе с тем, о чём должен уведомить.
#
# ⚠️ И СТРАНИЦА ОСТАЁТСЯ НА GITHUB PAGES. Наблюдатель её ПУШИТ, но не раздаёт: переехав сюда
# целиком, она умирала бы вместе с этой машиной — то есть ровно тогда, когда по ней хотят понять,
# что происходит.
set -Eeuo pipefail

REPO=${REPO:-https://github.com/Genrihbag/dentboard-status.git}
DIR=${DIR:-/opt/dentboard-status}
USER_NAME=${USER_NAME:-status}
ENV_FILE=${ENV_FILE:-/etc/dentboard-status.env}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\nОТКАЗ: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "запускать из-под root"

say "1. Проверяю, что нужное есть"
missing=()
for cmd in git node curl systemctl; do
  command -v "$cmd" > /dev/null 2>&1 || missing+=("$cmd")
done
# Отказ НАЗЫВАЕТ недостающее целиком, а не первое попавшееся: иначе установка идёт по одной ошибке
# за круг, и человек ставит пакеты в три захода.
[ ${#missing[@]} -eq 0 ] || fail "не установлено: ${missing[*]} (apt install -y git curl nodejs)"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || fail "node ${node_major} слишком старый, нужен 20+ (там `fetch` встроен)"
echo "  git, node ${node_major}, curl, systemd — на месте"

say "2. Пользователь и каталог"
id -u "$USER_NAME" > /dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"
if [ -d "$DIR/.git" ]; then
  echo "  репозиторий уже есть, обновляю"
  # ⚠️ ОБНОВЛЯЕМ ОТ ИМЕНИ ВЛАДЕЛЬЦА, А НЕ ОТ ROOT — починка дефекта, найденного боевой установкой
  # 29.08.2026. Первый прогон делает `chown` на `status`, второй звал `git pull` от root, и git
  # отвечал «detected dubious ownership», отказываясь работать в чужом каталоге. То есть установщик
  # ломал сам себя ровно на втором запуске — на обновлении, ради которого его и запускают повторно.
  sudo -u "$USER_NAME" git -C "$DIR" pull -q --rebase
else
  git clone -q "$REPO" "$DIR"
  chown -R "$USER_NAME:$USER_NAME" "$DIR"
fi
chown -R "$USER_NAME:$USER_NAME" "$DIR"
# Чтобы `git` из-под root в этом каталоге тоже работал — руками туда заходят именно так.
git config --global --add safe.directory "$DIR" 2> /dev/null || true
echo "  $DIR готов"

say "3. Секреты"
# ⚠️ ФАЙЛ НЕ ПЕРЕЗАПИСЫВАЕТСЯ, ЕСЛИ ОН УЖЕ ЕСТЬ. Повторный прогон установки не должен стирать
# токен: «привести к заявленному» здесь означало бы сломать работающее — тот же случай, что с
# паролем, который человек уже сменил.
if [ -f "$ENV_FILE" ]; then
  echo "  $ENV_FILE уже есть — не трогаю"
else
  cat > "$ENV_FILE" <<'ENVEOF'
# Токен бота и чат, куда слать сбои. Получить chat_id: написать боту /chatid в нужном чате.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENVEOF
  chmod 600 "$ENV_FILE"
  chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  echo "  создан $ENV_FILE — ЗАПОЛНИТЕ ЕГО, иначе сообщения о сбоях уходить не будут"
fi

say "4. Доступ на запись в репозиторий"
# Наблюдатель пушит историю и страницу. Без ключа он будет работать и слать в Telegram, но страница
# замрёт — и это состояние обязано быть НАЗВАНО, а не обнаружено через неделю по старой подписи.
# 🔴 ПРОВЕРЯЕМ ЗАПИСЬ, А НЕ ЧТЕНИЕ — починка ложного «доступ есть» 29.08.2026. Первая редакция
# звала `git ls-remote`, но репозиторий ПУБЛИЧНЫЙ: читать его может кто угодно анонимно, и проверка
# отвечала «доступ к origin есть» ровно там, где записи не было ни на грамм. Выяснилось это на
# первом же круге — `could not read Username for https://github.com`.
#
# `push --dry-run` спрашивает то же самое, что делает наблюдатель, и ничего при этом не меняет:
# проверка совпадает с проверяемым действием, а не похожа на него.
if sudo -u "$USER_NAME" git -C "$DIR" push --dry-run -q origin HEAD:main > /dev/null 2>&1; then
  echo "  запись в origin работает"
else
  echo "  ⚠ ЗАПИСИ В РЕПОЗИТОРИЙ НЕТ. Проверка и Telegram будут работать, страница — ЗАМРЁТ."
  echo "    Четыре команды (третья — на сайте GitHub):"
  echo "      sudo -u $USER_NAME ssh-keygen -t ed25519 -N '' -f /home/$USER_NAME/.ssh/id_ed25519"
  echo "      cat /home/$USER_NAME/.ssh/id_ed25519.pub"
  echo "    → GitHub → репозиторий → Settings → Deploy keys → Add key, галочка «Allow write access»"
  echo "      sudo -u $USER_NAME ssh-keyscan -t ed25519 github.com >> /home/$USER_NAME/.ssh/known_hosts"
  echo "      sudo -u $USER_NAME git -C $DIR remote set-url origin git@github.com:Genrihbag/dentboard-status.git"
  echo "    ⚠️ Строка с ssh-keyscan обязательна: без неё первое соединение спросит «продолжить?»,"
  echo "       а спрашивать некого — таймер работает без человека, и push будет молча висеть."
fi

say "5. Таймер"
ln -sf "$DIR/vps/dentboard-status.service" /etc/systemd/system/
ln -sf "$DIR/vps/dentboard-status.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dentboard-status.timer
echo "  таймер включён"

say "6. Приёмка — один круг ПРЯМО СЕЙЧАС"
# ⚠️ УСТАНОВКА ЗАКАНЧИВАЕТСЯ ПРОВЕРКОЙ, А НЕ СООБЩЕНИЕМ «ГОТОВО». «Поставил» без прогона —
# утверждение, а не факт: юнит может не найти node, не иметь прав на каталог, упереться в сеть, и
# узнать об этом через час по молчащей странице — худший из возможных способов.
if systemctl start dentboard-status.service; then
  echo "  круг выполнен, вывод:"
  journalctl -u dentboard-status.service -n 15 --no-pager -o cat | sed 's/^/    /'
else
  echo "  круг НЕ выполнен, разбор:"
  journalctl -u dentboard-status.service -n 30 --no-pager -o cat | sed 's/^/    /'
  fail "первый круг не прошёл — см. вывод выше"
fi

say "Готово. Что смотреть дальше"
cat <<'TAIL'
  systemctl list-timers dentboard-status.timer     — когда следующий круг
  journalctl -u dentboard-status.service -f        — что видит наблюдатель
  https://status.dentboard.ru                      — что видят люди

  ⚠️ Пока в /etc/dentboard-status.env пуст токен, сообщения о сбоях НЕ уходят.
     Проверка при этом идёт и страница обновляется — то есть «тихо» здесь не значит «сломано»,
     и отличить одно от другого можно только этой строкой в журнале:
       «телеграм не настроен … — сообщение не отправлено»
TAIL
