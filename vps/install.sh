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
# Слепок себя ДО обновления — см. перезапуск ниже.
self_before=$(sha256sum "$0" 2> /dev/null | cut -d' ' -f1 || echo нет)
id -u "$USER_NAME" > /dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"
if [ -d "$DIR/.git" ]; then
  echo "  репозиторий уже есть, обновляю"
  # ⚠️ СНАЧАЛА ВЕРНУТЬСЯ НА ВЕТКУ, ПОТОМ ОБНОВЛЯТЬСЯ. `reset --hard` не возвращает на ветку, а
  # незавершённый `rebase` оставляет дерево вне её — и `git pull` дальше отказывает: «You are not
  # currently on a branch». Установщик — это то место, куда человек приходит, КОГДА УЖЕ СЛОМАНО,
  # поэтому он обязан уметь выкарабкиваться, а не требовать целого дерева на входе.
  if ! sudo -u "$USER_NAME" git -C "$DIR" symbolic-ref -q HEAD > /dev/null; then
    echo "  дерево вне ветки — возвращаю на main"
    sudo -u "$USER_NAME" git -C "$DIR" rebase --abort 2> /dev/null || true
    sudo -u "$USER_NAME" git -C "$DIR" checkout -q -f main
  fi
  # ⚠️ ОБНОВЛЯЕМ ОТ ИМЕНИ ВЛАДЕЛЬЦА, А НЕ ОТ ROOT — починка дефекта, найденного боевой установкой
  # 29.08.2026. Первый прогон делает `chown` на `status`, второй звал `git pull` от root, и git
  # отвечал «detected dubious ownership», отказываясь работать в чужом каталоге. То есть установщик
  # ломал сам себя ровно на втором запуске — на обновлении, ради которого его и запускают повторно.
  # `--autostash` — дерево на боевой машине может быть тронуто чем угодно, и обновление не должно
  # ломаться от одного постороннего файла.
  sudo -u "$USER_NAME" git -C "$DIR" pull -q --rebase --autostash || {
    echo "  обновиться не удалось — привожу к удалённому состоянию"
    sudo -u "$USER_NAME" git -C "$DIR" fetch -q origin
    sudo -u "$USER_NAME" git -C "$DIR" reset -q --hard origin/main
  }
else
  git clone -q "$REPO" "$DIR"
  chown -R "$USER_NAME:$USER_NAME" "$DIR"
fi
chown -R "$USER_NAME:$USER_NAME" "$DIR"
# Чтобы `git` из-под root в этом каталоге тоже работал — руками туда заходят именно так.
git config --global --add safe.directory "$DIR" 2> /dev/null || true

# 🔴 ЕСЛИ ОБНОВИЛСЯ САМ УСТАНОВЩИК — ПЕРЕЗАПУСКАЕМСЯ ЕГО НОВОЙ ВЕРСИЕЙ.
#
# Найдено боевым прогоном 29.08.2026: `git pull` подменил этот файл ПОСРЕДИ его исполнения, и
# дальше работала старая логика — починка, ради которой прогон и затевался, применилась только со
# второго раза. Выглядело это как «правка не помогла», хотя правка была верна.
#
# Хуже, что bash читает скрипт по мере исполнения, по смещению в файле: подмена длины сдвигает
# границы команд, и вместо старой логики может исполниться мусор. То есть это не только неудобство,
# но и способ получить непредсказуемое поведение на боевой машине.
self_after=$(sha256sum "$0" 2> /dev/null | cut -d' ' -f1 || echo нет)
if [ "$self_before" != "$self_after" ] && [ -z "${DENTBOARD_REEXEC:-}" ]; then
  echo "  установщик обновился — перезапускаю себя новой версией"
  DENTBOARD_REEXEC=1 exec bash "$0" "$@"
fi
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
  echo "      ssh-keyscan -t ed25519 github.com | sudo -u $USER_NAME tee -a /home/$USER_NAME/.ssh/known_hosts"
  echo "      sudo -u $USER_NAME git -C $DIR remote set-url origin git@github.com:Genrihbag/dentboard-status.git"
  echo "    ⚠️ Строка с ssh-keyscan обязательна: без неё первое соединение спросит «продолжить?»,"
  echo "       а спрашивать некого — таймер работает без человека, и push будет молча висеть."
  echo "    ⚠️ И записывать её надо ЧЕРЕЗ tee, а не через '>>': перенаправление выполняет оболочка"
  echo "       ROOT, поэтому файл достаётся root, и ssh от имени $USER_NAME потом не может его"
  echo "       переписать — «hostfile_replace_entries: Operation not permitted»."
fi

say "5. Сайт состояния"
SITE_DIR=${SITE_DIR:-/var/www/status}
# ⚠️ ВЛАДЕЛЕЦ СТАВИТСЯ ЯВНО И НА ВЕСЬ КАТАЛОГ. `install -d -o … a/b` не гарантирует владельца
# ПРОМЕЖУТОЧНЫМ каталогам, а если каталог уже существовал — не трогает его вовсе. Итог был виден
# на боевой установке 29.08.2026: `/var/www/status` принадлежал root, и круг падал на
# «install: cannot create regular file … Permission denied» — проверка при этом шла, страница не
# обновлялась, и по журналу это выглядело как мелкое предупреждение.
install -d "$SITE_DIR/data" /var/www/certbot
chown -R "$USER_NAME:$USER_NAME" "$SITE_DIR"
if command -v nginx > /dev/null 2>&1; then
  ln -sf "$DIR/vps/status-site-http.conf" /etc/nginx/sites-available/dentboard-status-http.conf
  ln -sf "$DIR/vps/status-site.conf" /etc/nginx/sites-available/dentboard-status.conf
  # ⚠️ ПОЛОВИНА НА 80-м ПОРТУ ВКЛЮЧАЕТСЯ СРАЗУ: она не требует сертификата и нужна, чтобы его
  # получить. Половина с TLS — только после certbot, иначе nginx не стартует и унесёт с собой всё
  # остальное на этой машине.
  ln -sf /etc/nginx/sites-available/dentboard-status-http.conf /etc/nginx/sites-enabled/ 2> /dev/null || true
  if nginx -t > /dev/null 2>&1; then
    systemctl reload nginx
    echo "  половина на 80-м порту включена (нужна для проверки владения доменом)"
  else
    echo "  ⚠ nginx не принял конфигурацию — смотрите nginx -t"
  fi
  # ⚠️ САЙТ НЕ ВКЛЮЧАЕТСЯ АВТОМАТИЧЕСКИ. Без сертификата nginx не стартует, а рухнувший nginx унесёт
  # с собой ВСЁ, что на этой машине им обслуживается, — мы это уже видели сегодня на чужом мёртвом
  # апстриме. Включение делает человек, после certbot, и это осознанный порядок.
  if [ -e /etc/nginx/sites-enabled/dentboard-status.conf ]; then
    echo "  сайт уже включён"
    nginx -t > /dev/null 2>&1 && systemctl reload nginx && echo "  nginx перечитан"
  else
    echo "  ⚠ САЙТ ЕЩЁ НЕ ВКЛЮЧЁН — сначала сертификат, иначе nginx не поднимется:"
    echo "      certbot certonly --webroot -w /var/www/certbot -d status.dentboard.ru"
    echo "      ln -s /etc/nginx/sites-available/dentboard-status.conf /etc/nginx/sites-enabled/"
    echo "      nginx -t && systemctl reload nginx"
    echo "    ⚠️ И ДО ЭТОГО: A-запись status.dentboard.ru должна указывать на ЭТУ машину,"
    echo "       иначе certbot не подтвердит владение доменом."
  fi
else
  echo "  ⚠ nginx не установлен — страница будет собираться в $SITE_DIR, но раздавать её некому"
fi

say "6. Таймер"
ln -sf "$DIR/vps/dentboard-status.service" /etc/systemd/system/
ln -sf "$DIR/vps/dentboard-status.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dentboard-status.timer
echo "  таймер включён"

say "7. Приёмка — один круг ПРЯМО СЕЙЧАС"
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
  bash vps/probe-now.sh                            — круг прямо сейчас, с секретами
  TEST_MESSAGE=true bash vps/probe-now.sh          — плюс проверочное сообщение в канал

  ⚠️ Ручной запуск ТОЛЬКО так. `bash tick.sh` напрямую не видит /etc/dentboard-status.env —
     его подключает systemd, а не оболочка, — и честно скажет «телеграм не настроен» при
     совершенно исправной настройке.
  journalctl -u dentboard-status.service -f        — что видит наблюдатель
  https://status.dentboard.ru                      — что видят люди

  ⚠️ Пока в /etc/dentboard-status.env пуст токен, сообщения о сбоях НЕ уходят.
     Проверка при этом идёт и страница обновляется — то есть «тихо» здесь не значит «сломано»,
     и отличить одно от другого можно только этой строкой в журнале:
       «телеграм не настроен … — сообщение не отправлено»
TAIL
