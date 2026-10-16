package platform

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
)

var DemoAccounts = []M{{"email": "owner@manyvo.local", "name": "Мария", "role": "owner"}, {"email": "anna@manyvo.local", "name": "Анна", "role": "participant"}, {"email": "ivan@manyvo.local", "name": "Иван", "role": "participant"}, {"email": "alina@manyvo.local", "name": "Алина", "role": "participant"}, {"email": "max@manyvo.local", "name": "Максим", "role": "participant"}, {"email": "lena@manyvo.local", "name": "Елена", "role": "participant"}}

func (a *App) Seed(ctx context.Context) error {
	var count int
	if e := a.DB.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); e != nil {
		return e
	}
	if count > 0 {
		return a.seedRewards(ctx)
	}
	users := []User{}
	encoded := password("manyvo-demo", "")
	for _, account := range DemoAccounts {
		u := User{ID: ID(), Email: str(account, "email"), Name: str(account, "name"), Role: str(account, "role"), Age: ptr(25), Country: ptr("Россия")}
		if _, e := a.DB.Exec(ctx, "INSERT INTO users VALUES($1,$2,$3,$4,$5,$6,$7)", u.ID, u.Email, u.Name, u.Role, 25, "Россия", encoded); e != nil {
			return e
		}
		users = append(users, u)
	}
	owner := users[0]
	create := func(title, question string, variants []string, quota int) (string, error) {
		s, e := a.Create(ctx, owner)
		if e != nil {
			return "", e
		}
		options := []Option{}
		for _, v := range variants {
			options = append(options, Option{Text: v})
		}
		result, e := a.Save(ctx, owner, str(s, "id"), Draft{Title: title, Question: question, Version: 1, Quota: ptr(quota), AgeMin: ptr(18), AgeMax: ptr(65), Country: "Россия", Options: options})
		return str(result, "id"), e
	}
	if _, e := create("Как рассказать о новой подписке?", "Какое сообщение лучше передаёт ценность?", []string{"Больше возможностей. Каждый день.", "Всё, что любите, в одной подписке."}, 50); e != nil {
		return e
	}
	openSeed := func(id string) error {
		return a.transaction(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, "UPDATE studies SET status='open',published_at=$1,deadline=$2,moderation_provider='demo' WHERE id=$3", a.Clock(), a.Clock()+86400, id)
			if e != nil {
				return e
			}
			return a.event(ctx, tx, "published", id, "", nil)
		})
	}
	id, e := create("Какой заголовок хочется открыть?", "Представьте, что выбираете приложение для планирования. Какой заголовок привлечёт вас?", []string{"Меньше планов. Больше сделанного.", "Ваш день, в котором всё на своих местах.", "Освободите время для важного."}, 5)
	if e != nil {
		return e
	}
	if e = openSeed(id); e != nil {
		return e
	}
	closed, e := create("Выбираем сообщение для кофейни", "Какое сообщение убедит зайти за кофе по дороге на работу?", []string{"Хороший день начинается с хорошего кофе.", "Ваш любимый кофе. На минуту ближе.", "Пять минут для себя."}, 5)
	if e != nil {
		return e
	}
	if e = openSeed(closed); e != nil {
		return e
	}
	s, e := a.getStudy(ctx, a.DB, closed, false)
	if e != nil {
		return e
	}
	for i, p := range []int{0, 0, 1, 1, 2} {
		prediction := []int{0, 1, 1, 1, 2}[i]
		if _, e = a.Answer(ctx, users[i+1], closed, s.Options[p].ID, s.Options[prediction].ID); e != nil {
			return e
		}
	}
	return a.seedRewards(ctx)
}

func (a *App) seedRewards(ctx context.Context) error {
	var owner User
	if e := object(ctx, a.DB, "SELECT to_jsonb(u) FROM users u WHERE role='owner' ORDER BY id LIMIT 1", nil, &owner); e != nil {
		return e
	}
	var count int
	if e := a.DB.QueryRow(ctx, "SELECT count(*) FROM rewards").Scan(&count); e != nil {
		return e
	}
	if count > 0 {
		return nil
	}

	for _, channel := range []string{"guaranteed", "wheel"} {
		codes := []string{}
		for i := 1; i <= 500; i++ {
			codes = append(codes, fmt.Sprintf("DEMO-%s-%04d", channel, i))
		}
		title := "Демонстрационная гарантированная награда"
		if channel == "wheel" {
			title = "Демонстрационный приз колеса"
		}
		if _, e := a.CreateReward(ctx, owner, RewardInput{Title: title, Description: "Учебный купон для проверки механики. Не имеет денежной стоимости и не обменивается на реальные товары.", Channel: channel, Cost: 10, Demo: true, Codes: codes}); e != nil {
			return e
		}
	}
	return nil
}
