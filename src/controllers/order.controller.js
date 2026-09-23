import { processAndSendOrder, updateOrderStatusAndNotify } from '../services/order.service.js';

export const sendOrder = async (req, res) => {
  try {
    // Sanitizar payload: el backend genera SIEMPRE el orderNumber atómico oficial
    const payload = { ...req.body };
    delete payload.orderNumber;

    const result = await processAndSendOrder(payload);
    return res.json({
      success: result.success,
      message: result.message,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      file: result.file,
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    if (error.statusCode === 500) {
      return res.status(500).json({ error: error.message });
    }
    console.error('Error en sendOrder:', error);
    return res.status(500).json({ error: 'Error procesando el pedido.' });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { phone, status, amount, orderId } = req.body;
    const result = await updateOrderStatusAndNotify({ phone, status, amount, orderId });
    return res.json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error en updateOrderStatus:', error);
    return res.status(500).json({ error: 'Error enviando el estado del pedido' });
  }
};
