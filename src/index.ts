import 'koishi-adapter-discord'
import 'koishi-adapter-onebot'
import {Context, Session} from 'koishi-core'
import 'reflect-metadata'
import {CQBot} from 'koishi-adapter-onebot'
import {DiscordBot} from 'koishi-adapter-discord'
import {Logger, segment} from 'koishi-utils'
import {createConnection, getConnection} from 'typeorm'
import {MessageRelation} from './entity/message'
import DiscordId from './entity/discordId'
import {Embed, GuildMember, Message, Role, snowflake} from "koishi-adapter-discord/lib/types";

// @ts-ignore
import {data} from 'qface'

require('dotenv').config()

interface RelayRelation {
  discordChannel: string;
  discordGuild: string;
  onebotChannel: string;
  webhookId: string;
  webhookToken: string;
  discordLogChannel?: string;
}

export interface Config {
  database: {
    host: string;
    username: string;
    password: string;
    database: string;
  }
  onebotSelfId: string;
  discordToken: string;
  relations: RelayRelation[]
}

let c: Config;
const logger = new Logger('relay')

export async function apply(ctx: Context, config?: Config) {
  const {host, username, password, database} = config.database
  c = config
  await createConnection({
    type: "mysql",
    host,
    username,
    password,
    database,
    synchronize: true,
    entities: [MessageRelation, DiscordId]
  })
  
  ctx.on('message-updated', async (meta) => {
    if (config.relations.map(v => v.webhookId).includes(meta.userId)) {
      return;
    }
    if (!config.relations.map(v => v.discordChannel).concat(config.relations.map(v => v.onebotChannel)).includes(meta.channelId)) {
      return
    }
    if (meta.platform === "discord") {
      await meta.preprocess()
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      let data = await getConnection().getRepository(MessageRelation).createQueryBuilder("mr")
        .leftJoinAndSelect("mr.discordIds", "discordId")
        .where('discordId.id = :discord')
        .andWhere("deleted = :deleted")
        .setParameters({
          discord: meta.messageId,
          deleted: false
        })
        .getOne()
      const onebotChannel = config.relations.find(v => v.discordChannel === meta.channelId).onebotChannel
      if (data) {
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
        try {
          await onebot.deleteMessage('', data.onebot)
        } catch (e) {
        }
        const msg = await adaptMessage(meta as unknown as Session.Payload<"message", any>)
        data.onebot = await onebot.sendGroupMessage(onebotChannel, msg + "(edited)")
        data.deleted = false
        await getConnection().getRepository(MessageRelation).save(data)
      } else {
      }
    }
  })
  
  ctx.on('message-deleted', async (meta) => {
    if (meta.platform === "discord") {
      let data = await getConnection().getRepository(MessageRelation).createQueryBuilder("mr")
        .leftJoinAndSelect("mr.discordIds", "discordId")
        .where('discordId.id = :discord')
        .andWhere("deleted = :deleted")
        .setParameters({
          discord: meta.messageId,
          deleted: false
        })
        .getOne()
      if (data) {
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
        const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
        try {
          await onebot.deleteMessage('', data.onebot)
        } catch (e) {
        
        }
      }
    } else {
      let data = await getConnection().getRepository(MessageRelation).findOne({
        where: {
          onebot: meta.messageId.toString(),
          deleted: false
        },
        relations: ["discordIds"]
      })
      if (data) {
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
        const discordChannel = config.relations.find(v => v.onebotChannel === meta.channelId)
        const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
        for (const msgId of data.discordIds) {
          try {
            await dcBot.deleteMessage(discordChannel.discordChannel, msgId.id)
          } catch (e) {
          
          }
        }
        if (discordChannel.discordLogChannel) {
          await dcBot.sendMessage(discordChannel.discordLogChannel, `[QQ:${meta.userId}]撤回消息:\n${data.message}`)
        }
      }
    }
  })
  
  ctx.on('message', async (meta) => {
    if (!config.relations.map(v => v.discordChannel).concat(config.relations.map(v => v.onebotChannel)).includes(meta.channelId)) {
      return
    }
    if (config.relations.map(v => v.webhookId).includes(meta.userId)) {
      return;
    }
    if (meta.content.startsWith("//")) {
      return;
    }
    const relation = config.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
    if (meta.platform === 'discord') {
      await meta.preprocess()
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      // const dcBot = meta.bot as DiscordBot
      const msg = await adaptMessage(meta)
      let sendId = await onebot.sendGroupMessage(relation.onebotChannel, msg)
      let r = new MessageRelation()
      r.discordIds = [meta.messageId].map(v => {
        let a = new DiscordId()
        a.id = v
        return a
      })
      r.onebot = sendId
      r.message = meta.content
      await getConnection().getRepository(MessageRelation).save(r)
    } else {
      const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      const data = await adaptOnebotMessage(meta)
      let sentId = await dcBot.$executeWebhook(relation.webhookId, relation.webhookToken, {...data, tts: false}, true)
      let r = new MessageRelation()
      r.discordIds = [sentId].map(v => {
        let a = new DiscordId()
        a.id = v
        return a
      })
      r.onebot = meta.messageId
      r.message = meta.content
      await getConnection().getRepository(MessageRelation).save(r)
    }
  })
  
  ctx.command('relay', '查看同步插件帮助信息', {
    minInterval: 10000
  })
    .action(() => `仓库地址: https://github.com/koishijs/koishi-plugin-dcqq-relay`)
}

const adaptMessage = async (meta: Session.Payload<"message", any>) => {
  const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
  const msg = await dcBot.request<Message>('GET', `/channels/${meta.channelId}/messages/${meta.messageId}`)
  let roles: Role[] = undefined
  let members: Record<snowflake, GuildMember> = {}
  let contents = (await Promise.all(segment.parse(meta.content).map(async v => {
    if (v.type === "face") {
      return segment('image', {file: `https://cdn.discordapp.com/emojis/${v.data.id}`})
    } else if (v.type === "file") {
      return `[文件: ${v.data.file}]`
    } else if (v.type === "video") {
      return `[视频: ${v.data.file}]`
    } else if (v.type === "sharp") {
      let channel = await dcBot.$getChannel(v.data.id)
      return `[频道: ${channel.name}(${v.data.id})]`
    } else if (v.type === 'at') {
      if (v.data.type === "here") {
        return `@${v.data.type}`
      } else if (v.data.type === 'all') {
        return segment.join([v]).trim()
      }
      
      const dcBot = meta.bot as DiscordBot
      if (v.data.id) {
        let member = members[v.data.id] || await dcBot.$getGuildMember(meta.groupId, v.data.id)
        members[v.data.id] = member
        let username
        
        if (member.nick && member.nick !== member.user.username) {
          username = `${member.nick}(${member.user.username}#${member.user.discriminator})`
        } else {
          username = `${member.user.username}#${member.user.discriminator}`
        }
        return `@${username} `
      }
      if (v.data.role) {
        roles = roles || await dcBot.$getGuildRoles(meta.groupId)
        return `@[身分組]${roles.find(r => r.id === v.data.role)?.name || '未知'} `
      }
      return ''
    } else if (v.type === "share") {
      return v.data?.title + ' ' + v.data.url
    } else if (v.type === 'quote') {
      return ''
    }
    return segment.join([v]).trim()
  }))).join('')
  contents = msg.embeds.map(embed => {
    let rtn = ''
    rtn += embed.description || ''
    embed.fields?.forEach(field => {
      rtn += `${field.name}: ${field.value}\n`
    })
    return rtn
  }) + contents
  
  let quotePrefix = ""
  let quoteObj: MessageRelation | null;
  if (meta.quote) {
    quoteObj = await getConnection().getRepository(MessageRelation).createQueryBuilder("mr")
      .leftJoinAndSelect("mr.discordIds", "discordId")
      .where('discordId.id = :discord')
      .setParameters({
        discord: meta.quote.messageId
      })
      .getOne()
    if (quoteObj) {
      quotePrefix = segment('reply', {id: quoteObj.onebot})
    }
  }
  let username
  if (meta.author.nickname !== meta.author.username) {
    username = `${meta.author.nickname}(${meta.author.username}#${meta.author.discriminator})`
  } else {
    username = `${meta.author.username}#${meta.author.discriminator}`
  }
  return `${quotePrefix}${username}:\n${contents}`
}
const adaptOnebotMessage = async (meta: Session.Payload<"message", any>) => {
  const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
  let parsed = segment.parse(meta.content)
  const quoteObj = parsed.find(v => v.type === 'quote')
  let quoteId = null
  let quote: MessageRelation | null = null;
  if (quoteObj) {
    quote = await getConnection().getRepository(MessageRelation).findOne({
      where: {
        onebot: quoteObj.data.id
      }, relations: ["discordIds"]
    })
    if (quote) {
      quoteId = quote.discordIds[0].id
    } else {
      logger.info('quote not found %s', quoteObj.data.id)
    }
  }
  let embeds: Embed[] = []
  let contents = (await Promise.all(parsed.map(async v => {
    if (v.type === "quote") {
      return ''
    }
    if (v.type === 'at') {
      if (v.data.id === onebot.selfId) {
        return ''
      }
      let info = await onebot.$getGroupMemberInfo(meta.groupId, v.data.id)
      return `@[QQ: ${v.data.id}]${info.nickname} `
    }
    if (v.type === 'text') {
      return segment.unescape(v.data.content).trim()
    }
    if (v.type === 'image' && v.data.type === 'flash') {
      return ''
    }
    if (v.type === 'reply') {
      return ''
    }
    if (v.type === 'face') {
      let alt = data.find(face => face.QSid === v.data.id)
      return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${v.data.id}]`
    }
    return segment.join([v]).trim()
  }))).join('')
  contents = contents.replace(/@everyone/g, () => '\\@everyone').replace(/@here/g, () => '\\@here')
  const relation = c.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
  if (quoteId) {
    embeds.push({
      description: `回复 | [[ ↑ ]](https://discord.com/channels/${relation.discordGuild}/${relation.discordChannel}/${quoteId})`,
      footer: {
        text: segment.parse(quote?.message || '').filter(v => v.type === "text").map(v => segment.join([v])).join('')
      }
    })
  }
  return {
    content: contents,
    embeds,
    username: `[QQ:${meta.userId}] ${meta.username}`,
    avatar_url: `https://q1.qlogo.cn/g?b=qq&nk=${meta.userId}&s=640`
  }
}
