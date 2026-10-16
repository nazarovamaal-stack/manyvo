FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -o /server ./cmd/server
FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D manyvo
COPY --from=build /server /server
USER manyvo
EXPOSE 8080
ENTRYPOINT ["/server"]
