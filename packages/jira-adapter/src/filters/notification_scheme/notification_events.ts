/*
*                      Copyright 2022 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import { AdditionChange, Change, getChangeData, getDeepInnerType, InstanceElement, isAdditionChange, isModificationChange, isObjectType, isRemovalChange, ModificationChange, ObjectType, toChange, Values } from '@salto-io/adapter-api'
import { values as lowerdashValues } from '@salto-io/lowerdash'
import _ from 'lodash'
import { logger } from '@salto-io/logging'
import { resolveChangeElement, safeJsonStringify } from '@salto-io/adapter-utils'
import Joi from 'joi'
// import { getFilledJspUrls } from '../../utils'
import JiraClient from '../../client/client'
// import { JiraConfig } from '../../config/config'
// import { deployWithJspEndpoints } from '../../deployment/jsp_deployment'
// import { NOTIFICATION_EVENT_TYPE_NAME } from '../../constants'
import { getLookUpName } from '../../reference_mapping'
import { isPageResponse } from '../automation/automation_fetch'

const log = logger(module)

type EventValues = {
  eventType: string
  type: string
  parameter?: unknown
  id?: string
}

export const EVENT_TYPES: Record<string, string> = { // need to refactor the event types names !!!
  // User: 'SingleUser', // not working - User is not supported
  // Group: 'GroupDropdown', // not working - Group is not supported
  // ProjectRole: 'Project_Role' // not working - ProjectRole is not supported
  // UserCustomField: 'User_Custom_Field' // not working - UserCustomField is not supported,
  GroupCustomFieldll: 'Group_Custom_Field_Value', // not working - GroupCustomField is not supported,
}

type Notifications = {
  notificationType: string
  parameter?: unknown // maybe add display name
  user?: unknown
  additionalProperties?: unknown
  id?: number
}

type NotificationEvent = {
  event?: {
    id: number
  }
  eventType?: number
  notifications: Notifications[]
}

type NotificationScheme = {
  notificationSchemeEvents: NotificationEvent[]
}

const NOTIFICATION_SCHEME = Joi.object({
  notificationSchemeEvents: Joi.array().items(
    Joi.object({
      event: Joi.object({
        id: Joi.number().required(),
      }).unknown(true).required(),
      notifications: Joi.array().items(
        Joi.object({
          notificationType: Joi.string().required(),
        }).unknown(true)
      ).optional(),
    }).unknown(true)
  ).optional(),
}).unknown(true).required()

export const isNotificationScheme = (value: unknown): value is NotificationScheme => {
  const { error } = NOTIFICATION_SCHEME.validate(value)
  if (error !== undefined) {
    log.error(`Received an invalid notification scheme: ${error.message}, ${safeJsonStringify(value)}`)
    return false
  }
  return true
}

const transformNotificationEvent = (notificationEvent: NotificationEvent): void => {
  notificationEvent.eventType = notificationEvent.event?.id
  delete notificationEvent.event
  notificationEvent.notifications?.forEach((notification: Values) => {
    notification.type = notification.notificationType
    delete notification.notificationType
    delete notification.additionalProperties
    delete notification.user
  })
}

export const transformAllNotificationEvents = (notificationSchemeValues: Values): void => {
  if (!isNotificationScheme(notificationSchemeValues)) {
    throw new Error('Received an invalid notification scheme')
  }
  notificationSchemeValues.notificationSchemeEvents
    ?.forEach(transformNotificationEvent)
}

// const data = {
//   notificationSchemeEvents: [{
//     event: {
//       id: eventInstance.value.eventTypeIds,
//     },
//     notifications: [
//       {
//         notificationType: eventInstance.value.type,
//         parameter: eventInstance.value.parameter,
//       },
//     ],
//   }],
// }

const convertValuesToJSPBody = (values: Values, instance: InstanceElement): Values => {
  const type = EVENT_TYPES[values.type] ?? values.type
  return _.pickBy({
    event: { id: values.eventType },
    notifications: instance.value.notificationSchemeEvents
      .filter((event: NotificationEvent) => event.eventType === values.eventType)
      .flatMap((event: NotificationEvent) => event.notifications),
    id: values.id,
    schemeId: instance.value.id,
    name: values.name,
    eventTypeIds: values.eventType,
    type,
    [type]: values.parameter?.toString(),
  }, lowerdashValues.isDefined)
}

export const getEventKey = (event: EventValues): string =>
  `${event.eventType}-${event.type}-${event.parameter}`

export const getEventsValues = (
  instanceValues: Values,
): EventValues[] =>
  (instanceValues.notificationSchemeEvents ?? [])
    .flatMap((event: Values) => (event.notifications ?? []).map((notification: Values) => ({
      eventType: event.eventType,
      type: notification.type,
      parameter: notification.parameter,
      id: notification.id,
    })))

const getEventInstances = (
  instance: InstanceElement,
  eventType: ObjectType,
): InstanceElement[] =>
  getEventsValues(instance.value)
    .map(event => new InstanceElement(
      getEventKey(event),
      eventType,
      convertValuesToJSPBody({
        ...event,
        name: getEventKey(event),
        id: instance.value.notificationIds?.[getEventKey(event)],
      }, instance),
    ))

const getEventType = async (change: Change<InstanceElement>): Promise<ObjectType> => {
  const notificationSchemeType = await getChangeData(change).getType()
  const eventType = await getDeepInnerType(
    await notificationSchemeType.fields.notificationSchemeEvents.getType()
  )

  if (!isObjectType(eventType)) {
    throw new Error('Expected event type to be an object type')
  }

  return eventType
}

const getEventChanges = async (
  change: AdditionChange<InstanceElement> | ModificationChange<InstanceElement>
): Promise<Change<InstanceElement>[]> => {
  const eventType = await getEventType(change)
  const eventInstancesBefore = _.keyBy(
    isModificationChange(change)
      ? getEventInstances(change.data.before, eventType) // try to add new event
      : [],
    instance => instance.elemID.getFullName(),
  )

  const eventInstancesAfter = _.keyBy(
    getEventInstances(change.data.after, eventType),
    instance => instance.elemID.getFullName(),
  )

  const newEvents = Object.values(eventInstancesAfter)
    .filter(instance => eventInstancesBefore[instance.elemID.getFullName()] === undefined)

  const removedEvents = Object.values(eventInstancesBefore)
    .filter(instance => eventInstancesAfter[instance.elemID.getFullName()] === undefined)

  return [
    ...removedEvents.map(event => toChange({ before: event })),
    ...newEvents.map(event => toChange({ after: event })),
  ]
}

export const deployEvents = async (
  change: AdditionChange<InstanceElement> | ModificationChange<InstanceElement>,
  client: JiraClient,
): Promise<void> => {
  const eventChanges = await getEventChanges(await resolveChangeElement(change, getLookUpName))
  const instance = getChangeData(change)

  await Promise.all(eventChanges.map(async eventChange => {
    const eventInstance = getChangeData(eventChange)
    const notificationSchemeId = eventInstance.value.schemeId
    if (isRemovalChange(eventChange)) {
      const notificationId = instance.value.notificationIds[eventInstance.value.name]
      await client.delete(
        {
          url: `/rest/api/3/notificationscheme/${notificationSchemeId}/notification/${notificationId}`,
        }
      )
      delete instance.value.notificationIds[eventInstance.value.name]
    }

    if (isAdditionChange(eventChange)) {
      if (instance.value.notificationIds === undefined) {
        instance.value.notificationIds = {}
      }
      // eslint-disable-next-line no-console
      console.log('here')
      const data = {
        notificationSchemeEvents: [{
          event: {
            id: eventInstance.value.eventTypeIds,
          },
          notifications: eventInstance.value.notifications.map((notification: Notifications) => _.pickBy({
            notificationType: EVENT_TYPES[notification.notificationType] ?? notification.notificationType,
            parameter: notification.parameter,
          }, lowerdashValues.isDefined)),
        }],
      }
      await client.put(
        {
          url: `/rest/api/3/notificationscheme/${notificationSchemeId}/notification`,
          data,
        }
      ) // what should I do if this fail
      const response = await client.getSinglePage(
        {
          url: '/rest/api/3/notificationscheme',
          queryParams: {
            id: notificationSchemeId,
            expand: 'notificationSchemeEvents',
          },
        }
      )
      if (isPageResponse(response.data) && isNotificationScheme(response.data.values[0])) {
        const notificationEvent = response.data.values[0].notificationSchemeEvents
          .filter((event: NotificationEvent) => event.event?.id === eventInstance.value.eventTypeIds)
          .flatMap((event: NotificationEvent) => event.notifications)
          .filter((notification: Notifications) =>
            notification.notificationType === eventInstance.value.type)
        instance.value.notificationIds[eventInstance.value.name] = notificationEvent[0].id
      }
    }
  }))

  // if (res.errors.length !== 0) {
  //   log.error(`Failed to deploy notification scheme events of
  // ${instance.elemID.getFullName()}: ${res.errors.join(', ')}`)
  //   throw new Error(`Failed to deploy notification scheme events of ${instance.elemID.getFullName()}`)
  // }
}
