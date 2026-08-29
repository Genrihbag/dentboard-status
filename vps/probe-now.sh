#!/usr/bin/env bash
# ПРОВЕРКА ВРУЧНУЮ — тем же путём и с тем же окружением, каким её делает таймер.
#
# 🔴 ЗАПУСКАТЬ `tick.sh` НАПРЯМУЮ НЕЛЬЗЯ, И ЭТО ЛОВУШКА, А НЕ НЕУДОБСТВО. Файл секретов подключает
# systemd (`EnvironmentFile=`), а не оболочка: `sudo -u status bash tick.sh` отработает без токена,
# честно напечатает «телеграм не настроен» — и человек решит, что токен не подхватился, хотя он
# лежит на месте и таймеру виден. Проверка показала бы не состояние системы, а свойство способа
# запуска.
#
# Здесь тот же `EnvironmentFile`, тот же пользователь, тот же скрипт — то есть проверяется ровно
# то, что работает, а не похожее на него.
#
#   bash vps/probe-now.sh                  # обычный круг
#   TEST_MESSAGE=true bash vps/probe-now.sh   # плюс проверочное сообщение в канал
set -Eeuo pipefail

DIR=${DIR:-/opt/dentboard-status}
USER_NAME=${USER_NAME:-status}
ENV_FILE=${ENV_FILE:-/etc/dentboard-status.env}

[ "$(id -u)" -eq 0 ] || { echo "запускать из-под root (нужен доступ к ${ENV_FILE})" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "нет ${ENV_FILE} — сначала bash vps/install.sh" >&2; exit 1; }

# 🔴 ОКРУЖЕНИЕ БЕРЁТСЯ ИЗ САМОГО ЮНИТА, А НЕ ПЕРЕПИСЫВАЕТСЯ ЗДЕСЬ. Первая редакция подключала только
# файл секретов — и упустила `SITE_DIR`, ту самую переменную, которая отключает поход в git. Ручной
# прогон из-за этого лез в репозиторий, спотыкался о брошенный rebase и сыпал ошибками, тогда как
# таймер в это же время работал безупречно.
#
# То есть вход, заведённый ради «того же окружения», повторял его НАПОЛОВИНУ и врал ровно тем
# способом, против которого создан. Спрашиваем systemd, что объявлено у юнита, и передаём как есть:
# второго экземпляра списка переменных не появляется, значит расходиться нечему.
declare -a extra=()
while read -r pair; do
  [ -n "$pair" ] && extra+=(--setenv="$pair")
done < <(systemctl show -p Environment --value dentboard-status.service 2> /dev/null | tr ' ' '\n')

exec systemd-run \
  --uid="$USER_NAME" \
  --property=EnvironmentFile="$ENV_FILE" \
  "${extra[@]}" \
  --setenv=TEST_MESSAGE="${TEST_MESSAGE:-false}" \
  --wait --pipe --quiet \
  /bin/bash "$DIR/tick.sh"
