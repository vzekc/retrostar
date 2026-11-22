-- How to reach a user: their forum nickname, to which the forum sends a
-- conversation, and their email address. A forum login records both.
ALTER TABLE "user"
    ADD COLUMN forum_nickname VARCHAR,
    ADD COLUMN email          VARCHAR;

CREATE UNIQUE INDEX user_forum_nickname_key ON "user" (LOWER(forum_nickname));
